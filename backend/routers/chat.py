"""
Router: /api/chat
Plain chatbot connected to Ollama with SSE streaming.
Supports optional DuckDuckGo web search augmentation.
"""

import json
import asyncio
from typing import AsyncGenerator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from services.llm import (
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

from langchain_core.messages import HumanMessage, SystemMessage

router = APIRouter()


# ------------------------------------------------------------------ #
# Schemas                                                              #
# ------------------------------------------------------------------ #

class ChatRequest(BaseModel):
    message:      str
    session_id:   str  = "default"
    model:        str  = DEFAULT_MODEL
    ollama_url:   str  = DEFAULT_OLLAMA_URL
    temperature:  float = Field(0.3, ge=0.0, le=1.0)
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
async def chat_stream(req: ChatRequest):
    """
    SSE endpoint - streams LLM tokens as they arrive.
    Event format:  data: {"token": "..."}\n\n
    Final event:   data: {"done": true}\n\n
    """
    assert_llm_ready(
        provider=req.provider,
        ollama_url=req.ollama_url,
        api_base_url=req.api_base_url,
        api_token=req.api_token,
    )

    async def generate() -> AsyncGenerator[str, None]:
        try:
            llm = get_llm_from_request(req)
            history = get_session_history(req.session_id)

            user_input = req.message
            web_results_data = []
            if req.use_web:
                # ── Notify client that web search is in progress ──
                yield f"data: {json.dumps({'status': 'searching', 'msg': '🔍 در حال جستجو در وب...'})}\n\n"
                await asyncio.sleep(0)
                web_results_data = await asyncio.to_thread(search, req.message, 10)
                if web_results_data:
                    yield f"data: {json.dumps({'status': 'search_done', 'msg': f'✅ {len(web_results_data)} نتیجه یافت شد'})}\n\n"
                    await asyncio.sleep(0)
                    web_ctx = "\n".join(r["body"] for r in web_results_data if r["body"])
                    user_input = f"{req.message}\n\n[نتایج جستجوی وب]\n{web_ctx}"
                else:
                    yield f"data: {json.dumps({'status': 'search_done', 'msg': '⚠️ نتیجه‌ای یافت نشد'})}\n\n"
                    await asyncio.sleep(0)

            messages = [
                SystemMessage(content=(
                    "/no_think\n"
                    "تو یک دستیار هوشمند به زبان فارسی هستی. "
                    "پاسخ‌های دقیق، مفید و کوتاه بده.\n/no_think"
                ))
            ] + list(history.messages) + [HumanMessage(content=user_input)]

            full_response = ""
            async for chunk in llm.astream(messages):
                token = chunk.content if hasattr(chunk, "content") else str(chunk)
                if token:
                    full_response += token
                    yield f"data: {json.dumps({'token': token}, ensure_ascii=False)}\n\n"
                    await asyncio.sleep(0)

            # Persist turn to history only if we got a complete response
            if full_response:
                history.add_user_message(req.message)
                history.add_ai_message(full_response)

            # Send web sources if available
            if web_results_data:
                web_sources = [
                    {"title": r.get("title",""), "body": r.get("body","")[:200], "link": r.get("link","")}
                    for r in web_results_data if r.get("body") or r.get("link")
                ]
                yield f"data: {json.dumps({'web_sources': web_sources}, ensure_ascii=False)}\n\n"

            yield f"data: {json.dumps({'done': True})}\n\n"

        except asyncio.CancelledError:
            # Client closed connection (stop button / page refresh) — silent exit
            pass
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")
