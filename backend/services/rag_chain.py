"""
RAG Chain — hybrid retrieval + streaming answer + sources.
"""

import asyncio
from typing import List, AsyncGenerator, Optional, Any

from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.documents import Document
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_community.chat_message_histories import ChatMessageHistory

_store: dict[str, ChatMessageHistory] = {}


def get_session_history(session_id: str) -> ChatMessageHistory:
    if session_id not in _store:
        _store[session_id] = ChatMessageHistory()
    msgs = _store[session_id].messages
    if len(msgs) > 6:
        _store[session_id].messages = msgs[-6:]
    return _store[session_id]


def clear_session(session_id: str) -> None:
    _store.pop(session_id, None)


def hydrate_session(session_id: str, messages: list[dict]) -> None:
    """
    Rebuild in-memory LangChain history from persisted DB messages
    so a resumed conversation keeps short-term context.
    """
    clear_session(session_id)
    hist = ChatMessageHistory()
    for m in messages[-6:]:
        role = (m.get("role") or "").strip()
        content = (m.get("content") or "").strip()
        if not content:
            continue
        if role == "user":
            hist.add_user_message(content)
        elif role == "assistant":
            hist.add_ai_message(content)
    _store[session_id] = hist


def _format_docs(docs: List[Document]) -> str:
    parts = []
    for i, d in enumerate(docs, 1):
        src = d.metadata.get("source_file", "")
        page = d.metadata.get("page", "")
        header = f"[منبع {i}"
        if src:
            header += f" — {src}"
        if page not in ("", None):
            try:
                header += f" ص{int(page) + 1}"
            except (ValueError, TypeError):
                pass
        header += "]"
        parts.append(f"{header}\n{d.page_content.strip()}")
    return "\n\n".join(parts)


async def rag_stream(
    llm,
    retriever,
    question: str,
    session_id: str,
    executor=None,
    human_content: Any = None,
    history_user_text: Optional[str] = None,
    retrieval_query: Optional[str] = None,
) -> AsyncGenerator[str, None]:
    """
    human_content: optional multimodal list for vision; otherwise `question` is used.
    history_user_text: compact label for memory (attachments).
    retrieval_query: text used for the knowledge-base search (defaults to `question`).
    """
    history = get_session_history(session_id)
    chat_history = list(history.messages)

    retrieve_q = (retrieval_query or question or "").strip()
    if len(retrieve_q) > 2000:
        retrieve_q = retrieve_q[:2000]

    yield "\x00STATUS\x00searching"
    docs = await asyncio.to_thread(retriever.invoke, retrieve_q)
    yield "\x00STATUS\x00done|" + str(len(docs))
    context = _format_docs(docs)

    if isinstance(human_content, list):
        system = (
            "/no_think\n"
            "You are an assistant for question-answering tasks. (Answer in Persian)\n"
            "Use the following retrieved context to answer the question.\n"
            "If you don't know the answer, say so honestly.\n"
            "Keep the answer concise.\n\n"
            f"Context:\n{context}\n"
            "/no_think"
        )
        messages = (
            [SystemMessage(content=system)]
            + list(chat_history)
            + [HumanMessage(content=human_content)]
        )
    else:
        qa_prompt = ChatPromptTemplate.from_messages([
            (
                "system",
                "/no_think\n"
                "You are an assistant for question-answering tasks. (Answer in Persian)\n"
                "Use the following retrieved context to answer the question.\n"
                "If you don't know the answer, say so honestly.\n"
                "Keep the answer concise.\n\n"
                "Context:\n{context}\n"
                "/no_think",
            ),
            MessagesPlaceholder("chat_history"),
            ("human", "{input}"),
        ])
        messages = qa_prompt.format_messages(
            context=context,
            chat_history=chat_history,
            input=human_content if isinstance(human_content, str) else question,
        )

    full_response = ""
    async for chunk in llm.astream(messages):
        token = chunk.content if hasattr(chunk, "content") else str(chunk)
        if token:
            full_response += token
            yield token

    if full_response:
        mem_user = history_user_text if history_user_text is not None else question
        if len(mem_user) > 1500:
            mem_user = mem_user[:1500] + "…"
        history.add_user_message(mem_user)
        history.add_ai_message(full_response)

    yield "\x00SOURCES\x00" + str([
        {
            "file": d.metadata.get("source_file", ""),
            "page": d.metadata.get("page", ""),
            "preview": d.page_content.strip()[:250],
        }
        for d in docs
    ])
