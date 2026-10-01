"""
Router: /api/chat
Plain chatbot connected to Ollama with SSE streaming.
Supports optional DuckDuckGo web search augmentation.
Supports image + document/code attachments (multipart).
"""

import json
import asyncio
from typing import AsyncGenerator, List, Tuple

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from services.sse import SSE_HEADERS, with_heartbeat
from services.llm import (
    DEFAULT_TEMPERATURE,
    get_llm_from_request,
    list_ollama_models,
    list_api_models,
    assert_llm_ready,
    DEFAULT_MODEL,
    DEFAULT_OLLAMA_URL,
    DEFAULT_API_BASE_URL,
)
from services.web_search import search
from services.rag_chain import get_session_history, clear_session
from services.attachments import (
    AttachmentBundle,
    parse_attachments,
    build_prompt_text,
    build_human_content,
    history_label,
    friendly_llm_error,
)

from langchain_core.messages import HumanMessage, SystemMessage

router = APIRouter()


# ------------------------------------------------------------------ #
# Schemas                                                              #
# ------------------------------------------------------------------ #

class ChatRequest(BaseModel):
    message:      str = ""
    session_id:   str  = "default"
    model:        str  = DEFAULT_MODEL
    ollama_url:   str  = DEFAULT_OLLAMA_URL
    temperature:  float = Field(DEFAULT_TEMPERATURE, ge=0.0, le=1.0)
    use_web:      bool = False
    web_results:  int  = Field(6, ge=1, le=20)
    provider:     str  = "ollama"
    api_base_url: str  = DEFAULT_API_BASE_URL
    api_token:    str  = ""


class ModelsRequest(BaseModel):
    provider:     str = "ollama"
    ollama_url:   str = DEFAULT_OLLAMA_URL
    api_base_url: str = DEFAULT_API_BASE_URL
    api_token:    str = ""


_SYSTEM = (
    "/no_think\n"
    "تو یک دستیار هوشمند به زبان فارسی هستی. "
    "پاسخ‌های دقیق، مفید و کوتاه بده.\n/no_think"
)


async def _parse_chat_request(request: Request) -> tuple[ChatRequest, AttachmentBundle]:
    """JSON (no files) or multipart/form-data with field `files`."""
    ctype = (request.headers.get("content-type") or "").lower()
    if "multipart/form-data" in ctype:
        form = await request.form()
        data = {
            "message": str(form.get("message") or ""),
            "session_id": str(form.get("session_id") or "default"),
            "model": str(form.get("model") or DEFAULT_MODEL),
            "ollama_url": str(form.get("ollama_url") or DEFAULT_OLLAMA_URL),
            "temperature": float(form.get("temperature") or DEFAULT_TEMPERATURE),
            "use_web": str(form.get("use_web") or "false").lower() in ("1", "true", "yes"),
            "provider": str(form.get("provider") or "ollama"),
            "api_base_url": str(form.get("api_base_url") or DEFAULT_API_BASE_URL),
            "api_token": str(form.get("api_token") or ""),
        }
        req = ChatRequest(**data)
        uploads: List[Tuple[str, bytes]] = []
        for key in ("files", "file", "attachments"):
            for item in form.getlist(key):
                if hasattr(item, "read"):
                    raw = await item.read()
                    uploads.append((getattr(item, "filename", None) or "file", raw))
        bundle = await asyncio.to_thread(parse_attachments, uploads) if uploads else AttachmentBundle()
        return req, bundle

    body = await request.json()
    req = ChatRequest(**body)
    return req, AttachmentBundle()


# ------------------------------------------------------------------ #
# Endpoints                                                            #
# ------------------------------------------------------------------ #

@router.post("/models")
def get_models(req: ModelsRequest):
    """Return models for the selected provider."""
    provider = (req.provider or "ollama").strip().lower()
    if provider in ("api", "openai", "openai_compatible", "remote"):
        models = list_api_models(req.api_base_url, req.api_token)
        return {
            "provider": "api",
            "models": [m["id"] for m in models],
            "model_items": models,
        }
    models = list_ollama_models(req.ollama_url)
    return {"provider": "ollama", "models": models, "model_items": [{"id": m, "label": m} for m in models]}


@router.post("/clear")
def clear_chat(session_id: str = "default"):
    clear_session(session_id)
    return {"status": "cleared"}


@router.post("/stream")
async def chat_stream(request: Request):
    """
    SSE endpoint - streams LLM tokens as they arrive.
    Accepts application/json OR multipart/form-data (message + files).
    """
    req, bundle = await _parse_chat_request(request)

    if not (req.message or "").strip() and bundle.empty:
        raise HTTPException(400, detail="پیام یا پیوست لازم است.")

    await asyncio.to_thread(
        assert_llm_ready,
        provider=req.provider,
        ollama_url=req.ollama_url,
        api_base_url=req.api_base_url,
        api_token=req.api_token,
    )

    prompt_base = build_prompt_text(req.message, bundle)
    hist_label = history_label(req.message, bundle)

    async def generate() -> AsyncGenerator[str, None]:
        try:
            llm = get_llm_from_request(req)
            history = get_session_history(req.session_id)

            user_input = prompt_base
            web_results_data = []
            if req.use_web:
                yield f"data: {json.dumps({'status': 'searching', 'msg': '🔍 در حال جستجو در وب...'})}\n\n"
                await asyncio.sleep(0)
                query = (req.message or "").strip() or prompt_base[:200]
                web_results_data = await asyncio.to_thread(search, query, 10)
                if web_results_data:
                    yield f"data: {json.dumps({'status': 'search_done', 'msg': f'✅ {len(web_results_data)} نتیجه یافت شد'})}\n\n"
                    await asyncio.sleep(0)
                    web_ctx = "\n".join(r["body"] for r in web_results_data if r["body"])
                    user_input = f"{prompt_base}\n\n[نتایج جستجوی وب]\n{web_ctx}"
                else:
                    yield f"data: {json.dumps({'status': 'search_done', 'msg': '⚠️ نتیجه‌ای یافت نشد'})}\n\n"
                    await asyncio.sleep(0)

            human = build_human_content(user_input, bundle)
            messages = [
                SystemMessage(content=_SYSTEM)
            ] + list(history.messages) + [HumanMessage(content=human)]

            full_response = ""
            async for chunk in llm.astream(messages):
                token = chunk.content if hasattr(chunk, "content") else str(chunk)
                if token:
                    full_response += token
                    yield f"data: {json.dumps({'token': token}, ensure_ascii=False)}\n\n"
                    await asyncio.sleep(0)

            if full_response:
                history.add_user_message(hist_label)
                history.add_ai_message(
                    full_response if len(full_response) <= 1500 else full_response[:1500] + "…"
                )

            if web_results_data:
                web_sources = [
                    {"title": r.get("title",""), "body": r.get("body","")[:200], "link": r.get("link","")}
                    for r in web_results_data if r.get("body") or r.get("link")
                ]
                yield f"data: {json.dumps({'web_sources': web_sources}, ensure_ascii=False)}\n\n"

            yield f"data: {json.dumps({'done': True})}\n\n"

        except asyncio.CancelledError:
            pass
        except Exception as e:
            yield f"data: {json.dumps({'error': friendly_llm_error(e, bundle)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(with_heartbeat(generate()), media_type="text/event-stream", headers=SSE_HEADERS)
