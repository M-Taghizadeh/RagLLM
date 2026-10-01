"""
Persist chat attachment images for history display (not for LLM re-send).
"""

from __future__ import annotations

import os
import re
import uuid
from pathlib import Path

from fastapi import HTTPException

from services.vectorstore import STORE_BASE_DIR

_SAFE = re.compile(r"[^a-zA-Z0-9._\-]+")


def _media_root(user_id: int) -> Path:
    return Path(STORE_BASE_DIR) / str(user_id) / "chat_media"


def save_chat_image(
    user_id: int,
    session_id: str,
    filename: str,
    mime: str,
    data: bytes,
) -> dict:
    """Save image bytes; return {name, mime, url, rel_path}."""
    ext = Path(filename).suffix.lower() or ".png"
    if ext not in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
        ext = ".png"
    safe_session = _SAFE.sub("_", (session_id or "s")[:64]) or "s"
    folder = _media_root(user_id) / safe_session
    folder.mkdir(parents=True, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex[:12]}{ext}"
    path = folder / stored_name
    path.write_bytes(data)
    # URL served by authenticated endpoint
    url = f"/api/rag/chat-media/{user_id}/{safe_session}/{stored_name}"
    return {
        "name": filename,
        "mime": mime,
        "url": url,
        "path": str(path),
    }


def resolve_chat_media_path(user_id: int, session_id: str, filename: str) -> Path:
    safe_session = _SAFE.sub("_", (session_id or "s")[:64]) or "s"
    safe_name = os.path.basename(filename)
    if not safe_name or ".." in safe_name:
        raise HTTPException(400, detail="نام فایل نامعتبر است.")
    path = _media_root(user_id) / safe_session / safe_name
    if not path.is_file():
        raise HTTPException(404, detail="فایل یافت نشد.")
    return path
