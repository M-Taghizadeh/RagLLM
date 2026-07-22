"""
RAG Chain — hybrid retrieval + streaming answer + sources.
"""

import asyncio
from typing import List, AsyncGenerator

from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.documents import Document
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
) -> AsyncGenerator[str, None]:
    history = get_session_history(session_id)
    chat_history = list(history.messages)

    docs = await asyncio.to_thread(retriever.invoke, question)
    context = _format_docs(docs)

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
        input=question,
    )

    full_response = ""
    async for chunk in llm.astream(messages):
        token = chunk.content if hasattr(chunk, "content") else str(chunk)
        if token:
            full_response += token
            yield token

    if full_response:
        history.add_user_message(question)
        history.add_ai_message(full_response)

    yield "\x00SOURCES\x00" + str([
        {
            "file": d.metadata.get("source_file", ""),
            "page": d.metadata.get("page", ""),
            "preview": d.page_content.strip()[:250],
        }
        for d in docs
    ])
