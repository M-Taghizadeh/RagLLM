"""
Router: /api/article
Crawl a web article URL, then chat over its content with SSE streaming.
"""

import json
import asyncio
from typing import AsyncGenerator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from services.crawler import fetch_article
from services.llm import get_llm, check_ollama, DEFAULT_MODEL, DEFAULT_OLLAMA_URL
from services.web_search import search_text_only
from services.rag_chain import get_session_history, clear_session

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables.history import RunnableWithMessageHistory
from langchain_community.chat_message_histories import ChatMessageHistory

router = APIRouter()

# session_id -> article content
_article_store: dict[str, dict] = {}


# ------------------------------------------------------------------ #
# Schemas                                                              #
# ------------------------------------------------------------------ #

class FetchRequest(BaseModel):
    url: str


class ArticleChatRequest(BaseModel):
    message:     str
    session_id:  str
    model:       str   = DEFAULT_MODEL
    ollama_url:  str   = DEFAULT_OLLAMA_URL
    temperature: float = Field(0.3, ge=0.0, le=1.0)
    use_web:     bool  = False


# ------------------------------------------------------------------ #
# Endpoints                                                            #
# ------------------------------------------------------------------ #

@router.post("/fetch")
def fetch_url(req: FetchRequest):
    """
    Crawl the given URL and store its text.
    Returns session_id, title, and a preview of the content.
    """
    try:
        result = fetch_article(req.url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {e}")

    import time
    session_id = f"article_{int(time.time() * 1000)}"
    _article_store[session_id] = result
    # Clear any existing chat history for this new session
    clear_session(session_id)

    return {
        "session_id": session_id,
        "title":      result["title"],
        "preview":    result["text"][:500],
        "length":     len(result["text"]),
    }


@router.post("/chat/stream")
async def article_chat_stream(req: ArticleChatRequest):
    """SSE streaming chat over a previously fetched article."""

    if req.session_id not in _article_store:
        raise HTTPException(
            status_code=404,
            detail="Session not found. Please fetch a URL first via POST /api/article/fetch"
        )
    if not check_ollama(req.ollama_url):
        raise HTTPException(
            status_code=503,
            detail=f"Ollama در دسترس نیست ({req.ollama_url}). لطفاً 'ollama serve' را اجرا کنید."
        )

    article = _article_store[req.session_id]

    async def generate() -> AsyncGenerator[str, None]:
        try:
            llm = get_llm(req.ollama_url, req.model, req.temperature)
            history = get_session_history(req.session_id)

            user_input = req.message
            if req.use_web:
                web_ctx = search_text_only(req.message, 5)
                if web_ctx:
                    user_input += f"\n\n[نتایج جستجوی وب]\n{web_ctx}"

            # Inject article as system context
            system_msg = SystemMessage(content=(
                "/no_think\n"
                "تو یک دستیار تحلیل محتوا به زبان فارسی هستی. "
                "با استفاده از متن مقاله زیر به پرسش‌ها پاسخ بده. "
                "اگر پاسخ در متن نیست، صادقانه بگو.\n\n"
                f"[متن مقاله]\n{article['text'][:12000]}\n\n/no_think"
            ))

            messages = [system_msg] + list(history.messages) + [HumanMessage(content=user_input)]

            full_response = ""
            async for chunk in llm.astream(messages):
                token = chunk.content if hasattr(chunk, "content") else str(chunk)
                if token:
                    full_response += token
                    yield f"data: {json.dumps({'token': token}, ensure_ascii=False)}\n\n"
                    await asyncio.sleep(0)

            if full_response:
                history.add_user_message(req.message)
                history.add_ai_message(full_response)

            yield f"data: {json.dumps({'done': True})}\n\n"

        except asyncio.CancelledError:
            pass  # client disconnected — stop silently
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.delete("/session/{session_id}")
def delete_article_session(session_id: str):
    _article_store.pop(session_id, None)
    clear_session(session_id)
    return {"status": "deleted"}
