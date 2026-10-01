"""
Chat attachments: images (vision) + PDF/Word/code → text.

Security:
- extension whitelist only
- per-file / total size caps (much smaller than indexing uploads)
- basename-only filenames
- text files: reject NUL / binary-looking payloads
- extracted text is length-capped
"""

from __future__ import annotations

import base64
import io
import os
import re
from dataclasses import dataclass, field
from typing import Any, List, Optional, Tuple

from fastapi import HTTPException

# ── Limits ────────────────────────────────────────────────────────────────────

MAX_ATTACHMENTS = int(os.environ.get("CHAT_ATTACH_MAX_FILES", "5"))
MAX_IMAGE_BYTES = int(os.environ.get("CHAT_ATTACH_MAX_IMAGE_MB", "8")) * 1024 * 1024
MAX_DOC_BYTES = int(os.environ.get("CHAT_ATTACH_MAX_DOC_MB", "15")) * 1024 * 1024
MAX_TEXT_CHARS = int(os.environ.get("CHAT_ATTACH_MAX_TEXT_CHARS", "80000"))
MAX_CODE_CHARS = int(os.environ.get("CHAT_ATTACH_MAX_CODE_CHARS", "60000"))

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
DOC_EXTS = {".pdf", ".docx"}  # .doc skipped (binary OLE; indexing path handles it separately)
CODE_EXTS = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".md", ".txt", ".csv",
    ".html", ".htm", ".css", ".xml", ".yaml", ".yml", ".sql", ".sh",
    ".bat", ".ps1", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp",
    ".cs", ".rb", ".php", ".r", ".toml", ".ini", ".kt", ".swift", ".scala",
}

_MIME_IMAGE = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

_SAFE_NAME = re.compile(r"[^\w.\u0600-\u06FF\- ]+", re.UNICODE)


@dataclass
class AttachmentBundle:
    images: List[Tuple[str, str, bytes]] = field(default_factory=list)  # name, mime, raw
    texts: List[Tuple[str, str]] = field(default_factory=list)  # name, extracted text

    @property
    def has_images(self) -> bool:
        return bool(self.images)

    @property
    def has_texts(self) -> bool:
        return bool(self.texts)

    @property
    def empty(self) -> bool:
        return not self.images and not self.texts


def _safe_filename(name: str) -> str:
    base = os.path.basename(name or "file").strip() or "file"
    base = _SAFE_NAME.sub("_", base)
    return base[:120]


def _ext(name: str) -> str:
    return os.path.splitext(name)[1].lower()


def _extract_pdf(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    if len(reader.pages) > 80:
        raise HTTPException(400, detail="PDF بیش از ۸۰ صفحه است؛ برای چت کوتاه‌تر ارسال کنید.")
    parts: List[str] = []
    total = 0
    for page in reader.pages:
        try:
            t = (page.extract_text() or "").strip()
        except Exception:
            t = ""
        if not t:
            continue
        parts.append(t)
        total += len(t)
        if total >= MAX_TEXT_CHARS:
            break
    text = "\n\n".join(parts)
    if not text.strip():
        raise HTTPException(400, detail="از PDF متنی استخراج نشد (ممکن است اسکن تصویری باشد).")
    return text[:MAX_TEXT_CHARS]


def _extract_docx(data: bytes) -> str:
    import docx

    document = docx.Document(io.BytesIO(data))
    parts = [p.text.strip() for p in document.paragraphs if p.text and p.text.strip()]
    # tables
    for table in document.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text and c.text.strip()]
            if cells:
                parts.append(" | ".join(cells))
    text = "\n".join(parts)
    if not text.strip():
        raise HTTPException(400, detail="از فایل Word متنی استخراج نشد.")
    return text[:MAX_TEXT_CHARS]


def _extract_code(data: bytes, filename: str) -> str:
    if b"\x00" in data[:8192]:
        raise HTTPException(400, detail=f"فایل «{filename}» باینری به نظر می‌رسد و مجاز نیست.")
    # high ratio of non-text bytes → reject
    sample = data[:4096]
    if sample:
        nontext = sum(1 for b in sample if b < 9 or (13 < b < 32) or b == 127)
        if nontext / len(sample) > 0.30:
            raise HTTPException(400, detail=f"فایل «{filename}» متنی نیست.")
    for enc in ("utf-8", "utf-8-sig", "cp1256", "latin-1"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            text = None
    else:
        raise HTTPException(400, detail=f"رمزگذاری فایل «{filename}» پشتیبانی نمی‌شود.")
    text = text.replace("\x00", "")
    if len(text) > MAX_CODE_CHARS:
        text = text[:MAX_CODE_CHARS] + "\n\n… [متن کوتاه شد]"
    return text


def parse_attachments(files: List[Tuple[str, bytes]]) -> AttachmentBundle:
    """
    files: list of (filename, raw_bytes)
    """
    if len(files) > MAX_ATTACHMENTS:
        raise HTTPException(400, detail=f"حداکثر {MAX_ATTACHMENTS} فایل در هر پیام مجاز است.")

    bundle = AttachmentBundle()
    for raw_name, data in files:
        if not data:
            continue
        name = _safe_filename(raw_name)
        ext = _ext(name)

        if ext in IMAGE_EXTS:
            if len(data) > MAX_IMAGE_BYTES:
                raise HTTPException(
                    400,
                    detail=f"تصویر «{name}» بزرگ‌تر از حد مجاز است "
                           f"({MAX_IMAGE_BYTES // (1024*1024)}MB).",
                )
            ok_magic = (
                data[:8] == b"\x89PNG\r\n\x1a\n"
                or data[:2] == b"\xff\xd8"
                or data[:6] in (b"GIF87a", b"GIF89a")
                or (data[:4] == b"RIFF" and len(data) >= 12 and data[8:12] == b"WEBP")
            )
            if not ok_magic:
                raise HTTPException(400, detail=f"محتوای تصویر «{name}» نامعتبر است.")
            mime = _MIME_IMAGE.get(ext, "image/png")
            bundle.images.append((name, mime, data))

        elif ext == ".pdf":
            if len(data) > MAX_DOC_BYTES:
                raise HTTPException(400, detail=f"فایل «{name}» بیش از حد بزرگ است.")
            if not data.startswith(b"%PDF"):
                raise HTTPException(400, detail=f"فایل «{name}» یک PDF معتبر نیست.")
            bundle.texts.append((name, _extract_pdf(data)))

        elif ext == ".docx":
            if len(data) > MAX_DOC_BYTES:
                raise HTTPException(400, detail=f"فایل «{name}» بیش از حد بزرگ است.")
            # zip/docx magic
            if data[:2] != b"PK":
                raise HTTPException(400, detail=f"فایل «{name}» یک Word معتبر نیست.")
            bundle.texts.append((name, _extract_docx(data)))

        elif ext in CODE_EXTS:
            if len(data) > MAX_DOC_BYTES:
                raise HTTPException(400, detail=f"فایل «{name}» بیش از حد بزرگ است.")
            bundle.texts.append((name, _extract_code(data, name)))

        else:
            raise HTTPException(
                400,
                detail=f"پسوند «{ext or '?'}» مجاز نیست. "
                       f"تصویر، PDF، Word یا فایل متنی/کد ارسال کنید.",
            )

    return bundle


def build_prompt_text(message: str, bundle: AttachmentBundle) -> str:
    """User text + extracted file bodies for the model prompt."""
    parts: List[str] = []
    msg = (message or "").strip()
    if msg:
        parts.append(msg)
    for name, text in bundle.texts:
        parts.append(f"[پیوست: {name}]\n{text}")
    return "\n\n".join(parts).strip() or "(پیوست بدون متن)"


def retrieval_text(message: str, bundle: AttachmentBundle) -> str:
    """Knowledge-base search query: the user's question; file text only when there is no question."""
    msg = (message or "").strip()
    if msg:
        return msg
    for _name, text in bundle.texts:
        if text.strip():
            return text.strip()[:1000]
    return " ".join(n for n, _, _ in bundle.images) or "(پیوست)"


def friendly_llm_error(exc: Exception, bundle: AttachmentBundle) -> str:
    text = str(exc)
    low = text.lower()
    if bundle.has_images and (
        "multimodal" in low
        or "image input" in low
        or "image_url" in low
        or "does not support image" in low
        or "vision" in low
    ):
        return (
            "مدل یا API انتخاب‌شده از تصویر پشتیبانی نمی‌کند. "
            "برای ارسال تصویر، در تنظیمات مدل زبانی Ollama را با یک مدل Vision "
            "(مثل llava:13b یا gemma4) انتخاب کنید، یا تصویر را حذف کنید."
        )
    return text


def history_label(message: str, bundle: AttachmentBundle) -> str:
    """Compact string for LangChain short-term memory (no huge extracts / no base64)."""
    bits: List[str] = []
    msg = (message or "").strip()
    if msg:
        bits.append(msg[:900])
    if bundle.images:
        names = "، ".join(n for n, _, _ in bundle.images[:5])
        bits.append(f"[{len(bundle.images)} تصویر: {names}]")
    for name, _text in bundle.texts:
        bits.append(f"[فایل پیوست: {name}]")
    label = "\n".join(bits).strip()
    return label[:900] if label else "(پیوست)"


# Markers for DB/display — frontend parses these into expandable chips / images
_FILE_OPEN = "<<<FILE name=\"{name}\">>>"
_FILE_CLOSE = "<<<ENDFILE>>>"
_IMG_LINE = "<<<IMG name=\"{name}\" src=\"{src}\">>>"


def build_stored_user_message(
    message: str,
    user_id: int,
    session_id: str,
    bundle: AttachmentBundle,
) -> str:
    """
    Content persisted in ChatHistory for UI resume:
    - plain user text
    - file extracts wrapped in <<<FILE>>> blocks (click-to-expand in UI)
    - images saved to disk + <<<IMG src=...>>> markers
    """
    from services.chat_media import save_chat_image

    parts: List[str] = []
    msg = (message or "").strip()
    if msg:
        parts.append(msg)

    for name, text in bundle.texts:
        parts.append(_FILE_OPEN.format(name=name))
        parts.append(text)
        parts.append(_FILE_CLOSE)

    for name, mime, raw in bundle.images:
        meta = save_chat_image(user_id, session_id, name, mime, raw)
        parts.append(_IMG_LINE.format(name=meta["name"], src=meta["url"]))

    return "\n".join(parts).strip() or "(پیوست)"


def stored_content_to_memory_text(content: str) -> str:
    """Strip FILE bodies / IMG markers down to compact labels for LangChain hydrate."""
    if not content:
        return ""
    text = content
    # Replace FILE blocks with short label
    text = re.sub(
        r'<<<FILE name="([^"]*)">>>\n?([\s\S]*?)<<<ENDFILE>>>',
        lambda m: f"[فایل پیوست: {m.group(1)}]",
        text,
    )
    text = re.sub(
        r'<<<IMG name="([^"]*)" src="[^"]*">>>',
        lambda m: f"[تصویر: {m.group(1)}]",
        text,
    )
    text = text.strip()
    return text[:1500] if len(text) > 1500 else text


def build_human_content(prompt_text: str, bundle: AttachmentBundle) -> Any:
    """
    String content when no images; OpenAI-style multimodal blocks when images exist.
    Works with ChatOllama vision models and OpenAI-compatible APIs.
    """
    if not bundle.has_images:
        return prompt_text

    blocks: List[dict] = [{"type": "text", "text": prompt_text or "لطفاً تصویر(ها) را بررسی کن."}]
    for _name, mime, raw in bundle.images:
        b64 = base64.b64encode(raw).decode("ascii")
        blocks.append({
            "type": "image_url",
            "image_url": {"url": f"data:{mime};base64,{b64}"},
        })
    return blocks


def ui_preview_payload(bundle: AttachmentBundle) -> dict:
    """Optional metadata for the client (no raw bytes)."""
    return {
        "images": [{"name": n, "mime": m} for n, m, _ in bundle.images],
        "files": [{"name": n, "chars": len(t)} for n, t in bundle.texts],
    }
