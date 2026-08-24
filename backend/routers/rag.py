"""
Router: /api/rag
PDF indexing with SSE progress + cancel support, hybrid RAG chat.
"""

import json
import os
import asyncio
import tempfile
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import AsyncGenerator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.formparsers import MultiPartParser
from starlette.datastructures import Headers

from services.vectorstore import (
    build_vectorstore_from_pdfs,
    load_vectorstore,
    load_documents,
    delete_collection,
    list_collections,
    collection_exists,
    sanitize_collection_name,
    DEFAULT_CHUNK_SIZE,
    DEFAULT_CHUNK_OVERLAP,
)
from services.retrieval import HybridRetriever
from services.llm import get_llm, check_ollama, DEFAULT_MODEL, DEFAULT_OLLAMA_URL, DEFAULT_TOP_K, DENSE_WEIGHT, SPARSE_WEIGHT
from services.rag_chain import rag_stream, clear_session
from services.web_search import search

router = APIRouter()

_executor = ThreadPoolExecutor(max_workers=2)
_cancel_events: dict[str, threading.Event] = {}

MAX_UPLOAD_BYTES = 500 * 1024 * 1024


class RagChatRequest(BaseModel):
    message: str
    collection: str = "default_pdf"
    session_id: str = "rag_default"
    model: str = DEFAULT_MODEL
    ollama_url: str = DEFAULT_OLLAMA_URL
    temperature: float = Field(0.3, ge=0.0, le=1.0)
    top_k: int = Field(default_factory=lambda: DEFAULT_TOP_K, ge=1, le=50)
    use_web: bool = False


@router.get("/collections")
def get_collections():
    return {"collections": list_collections()}


@router.delete("/collections/{collection}")
def remove_collection(collection: str):
    delete_collection(collection)
    return {"status": "deleted", "collection": collection}


async def _save_uploaded_pdfs(request: Request):
    headers = Headers(scope={"type": "http", "headers": request.scope["headers"]})
    parser = MultiPartParser(
        headers=headers,
        stream=request.stream(),
        max_files=100,
        max_fields=20,
        max_part_size=MAX_UPLOAD_BYTES,
    )
    form_data = await parser.parse()
    tmp_dir = tempfile.mkdtemp()
    saved_paths: list[str] = []

    try:
        collection = form_data.get("collection", "default_pdf")
        chunk_size = form_data.get("chunk_size", str(DEFAULT_CHUNK_SIZE))
        chunk_overlap = form_data.get("chunk_overlap", str(DEFAULT_CHUNK_OVERLAP))
        job_id = form_data.get("job_id", "")

        for key, val in form_data.multi_items():
            if key == "files" and hasattr(val, "filename") and val.filename.lower().endswith(".pdf"):
                dest = os.path.join(tmp_dir, val.filename)
                content = await val.read()
                with open(dest, "wb") as f:
                    f.write(content)
                saved_paths.append(dest)
    finally:
        await form_data.close()

    return tmp_dir, saved_paths, collection, chunk_size, chunk_overlap, job_id


@router.post("/index/stream")
async def index_pdfs_stream(request: Request):
    try:
        tmp_dir, saved_paths, collection, chunk_size_s, chunk_overlap_s, job_id = (
            await _save_uploaded_pdfs(request)
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, detail=f"خطا در دریافت فایل: {e}")

    if not saved_paths:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise HTTPException(400, detail="فایل PDF معتبری ارسال نشد.")

    chunk_size = int(chunk_size_s) if str(chunk_size_s).isdigit() else DEFAULT_CHUNK_SIZE
    chunk_overlap = (
        int(chunk_overlap_s) if str(chunk_overlap_s).isdigit() else DEFAULT_CHUNK_OVERLAP
    )

    safe_collection = sanitize_collection_name(collection)
    cancel_event = threading.Event()
    if job_id:
        _cancel_events[job_id] = cancel_event

    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_event_loop()

    def progress_cb(pct: int, detail: str):
        loop.call_soon_threadsafe(queue.put_nowait, {"progress": pct, "detail": detail})

    def run_indexing():
        try:
            _, total_chunks = build_vectorstore_from_pdfs(
                saved_paths,
                safe_collection,
                chunk_size,
                chunk_overlap,
                progress_callback=progress_cb,
                cancel_event=cancel_event,
            )
            if cancel_event.is_set():
                loop.call_soon_threadsafe(queue.put_nowait, {"cancelled": True})
            else:
                loop.call_soon_threadsafe(
                    queue.put_nowait,
                    {
                        "done": True,
                        "total_chunks": total_chunks,
                        "files": len(saved_paths),
                        "collection": safe_collection,
                        "original_name": collection,
                    },
                )
        except Exception as e:
            loop.call_soon_threadsafe(queue.put_nowait, {"error": str(e)})
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            _cancel_events.pop(job_id, None)

    _executor.submit(run_indexing)

    async def generate() -> AsyncGenerator[str, None]:
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=300.0)
                except asyncio.TimeoutError:
                    yield f"data: {json.dumps({'error': 'timeout'})}\n\n"
                    cancel_event.set()
                    break
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                if "done" in event or "error" in event or "cancelled" in event:
                    break
        except asyncio.CancelledError:
            cancel_event.set()

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.delete("/index/{job_id}")
def cancel_index(job_id: str):
    ev = _cancel_events.get(job_id)
    if ev:
        ev.set()
        return {"status": "cancellation_requested"}
    return {"status": "not_found"}


@router.post("/chat/stream")
async def rag_chat_stream(req: RagChatRequest):
    safe_col = sanitize_collection_name(req.collection)
    if not collection_exists(safe_col):
        raise HTTPException(404, detail=f"مجموعه '{req.collection}' هنوز ایندکس نشده است.")
    if not check_ollama(req.ollama_url):
        raise HTTPException(503, detail="Ollama در دسترس نیست. لطفاً 'ollama serve' را اجرا کنید.")

    async def generate() -> AsyncGenerator[str, None]:
        try:
            vs = load_vectorstore(safe_col)
            if vs is None:
                yield f"data: {json.dumps({'error': 'مجموعه پیدا نشد'})}\n\n"
                return

            docs = load_documents(safe_col)
            retriever = HybridRetriever(
                vectorstore=vs,
                documents=docs,
                dense_k=max(req.top_k * 2, 16),
                sparse_k=max(req.top_k * 2, 16),
                final_k=req.top_k,
                dense_weight=DENSE_WEIGHT,
                sparse_weight=SPARSE_WEIGHT,
            )
            llm = get_llm(req.ollama_url, req.model, req.temperature)
            user_input = req.message
            web_results_data = []

            if req.use_web:
                yield f"data: {json.dumps({'status': 'searching', 'msg': 'در حال جستجو در وب...'})}\n\n"
                await asyncio.sleep(0)
                web_results_data = await asyncio.to_thread(search, req.message, 10)
                if web_results_data:
                    yield f"data: {json.dumps({'status': 'search_done', 'msg': f'{len(web_results_data)} نتیجه یافت شد'})}\n\n"
                    await asyncio.sleep(0)
                    web_ctx = "\n".join(r["body"] for r in web_results_data if r["body"])
                    user_input += f"\n\n[نتایج جستجوی وب]\n{web_ctx}"
                else:
                    yield f"data: {json.dumps({'status': 'search_done', 'msg': 'نتیجه‌ای یافت نشد'})}\n\n"
                    await asyncio.sleep(0)

            sources_data = None
            async for token in rag_stream(
                llm=llm,
                retriever=retriever,
                question=user_input,
                session_id=req.session_id,
                executor=_executor,
            ):
                if token.startswith("\x00STATUS\x00"):
                    payload = token[len("\x00STATUS\x00"):]
                    if payload == "searching":
                        yield f"data: {json.dumps({'status': 'retrieving', 'msg': 'در حال جستجو در پایگاه دانش...'})}\n\n"
                    elif payload.startswith("done|"):
                        count = payload.split("|")[1]
                        yield f"data: {json.dumps({'status': 'retrieval_done', 'msg': f'{count} منبع یافت شد'})}\n\n"
                    await asyncio.sleep(0)
                    continue

                if token.startswith("\x00SOURCES\x00"):
                    try:
                        import ast

                        sources_data = ast.literal_eval(token[len("\x00SOURCES\x00") :])
                    except Exception:
                        pass
                    continue

                yield f"data: {json.dumps({'token': token}, ensure_ascii=False)}\n\n"
                await asyncio.sleep(0)

            if sources_data:
                yield f"data: {json.dumps({'sources': sources_data}, ensure_ascii=False)}\n\n"

            if web_results_data:
                web_sources = [
                    {
                        "title": r.get("title", ""),
                        "body": r.get("body", "")[:200],
                        "link": r.get("link", ""),
                    }
                    for r in web_results_data
                    if r.get("body") or r.get("link")
                ]
                yield f"data: {json.dumps({'web_sources': web_sources}, ensure_ascii=False)}\n\n"

            yield f"data: {json.dumps({'done': True})}\n\n"

        except asyncio.CancelledError:
            pass
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.post("/clear")
def clear_rag_session(session_id: str = "rag_default"):
    clear_session(session_id)
    return {"status": "cleared"}
