"""
Vectorstore Service — FAISS + BM25 corpus on disk.

Per-user layout (new):
  faiss_db/{user_id}/{folder_id}/index.faiss
  faiss_db/{user_id}/{folder_id}/index.pkl
  faiss_db/{user_id}/{folder_id}/docs.pkl
  faiss_db/{user_id}/{folder_id}/meta.json

Legacy layout (backward-compat, no user_id):
  faiss_db/{folder_id}/...
"""

from __future__ import annotations

import os
import re
import shutil
import hashlib
import pickle
import threading
from pathlib import Path
from typing import Callable, List, Optional, Tuple

import numpy as np
import faiss as faiss_lib
from langchain_core.documents import Document
from langchain_community.document_loaders import PyPDFLoader, Docx2txtLoader
from langchain_community.vectorstores import FAISS
from langchain_community.docstore.in_memory import InMemoryDocstore
from langchain_text_splitters import RecursiveCharacterTextSplitter

from services.embeddings import BGEEmbeddings

# ── Paths ──────────────────────────────────────────────────────────────────────

STORE_BASE_DIR = os.path.join(os.path.dirname(__file__), "..", "faiss_db")

ProgressCb  = Optional[Callable[[int, str], None]]
CancelEvent = Optional[threading.Event]

# Load .env from project root
_env_path = Path(__file__).resolve().parents[2] / ".env"
if _env_path.exists():
    for _line in _env_path.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

DEFAULT_CHUNK_SIZE    = int(os.environ.get("CHUNK_SIZE", "1000"))
DEFAULT_CHUNK_OVERLAP = int(os.environ.get("CHUNK_OVERLAP", "150"))

UPLOADS_BASE_DIR = os.environ.get(
    "UPLOADS_DIR",
    os.path.join(os.path.dirname(__file__), "..", "..", "data", "uploads"),
)


# ── Name sanitization ──────────────────────────────────────────────────────────

def sanitize_collection_name(name: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9._\-]", "_", name)
    safe = re.sub(r"[_]{2,}", "_", safe)
    safe = re.sub(r"^[^a-zA-Z0-9]+", "", safe)
    safe = re.sub(r"[^a-zA-Z0-9]+$", "", safe)
    if len(safe) < 3:
        suffix = hashlib.md5(name.encode("utf-8")).hexdigest()[:8]
        safe = (safe + "_" + suffix).strip("_")
    safe = safe[:128]
    safe = re.sub(r"^[^a-zA-Z0-9]+", "", safe)
    safe = re.sub(r"[^a-zA-Z0-9]+$", "", safe)
    if len(safe) < 3:
        safe = "col_" + hashlib.md5(name.encode("utf-8")).hexdigest()[:8]
    return safe


# ── Path helpers (per-user aware) ──────────────────────────────────────────────

def _user_base(user_id: Optional[int]) -> str:
    """Return the base directory for a user's FAISS collections."""
    if user_id is not None:
        return os.path.join(STORE_BASE_DIR, str(user_id))
    return STORE_BASE_DIR


def _store_path(collection: str, user_id: Optional[int] = None) -> str:
    return os.path.join(_user_base(user_id), sanitize_collection_name(collection))


def _docs_path(collection: str, user_id: Optional[int] = None) -> str:
    return os.path.join(_store_path(collection, user_id), "docs.pkl")


def _meta_path(collection: str, user_id: Optional[int] = None) -> str:
    return os.path.join(_store_path(collection, user_id), "meta.json")


def _uploads_dir(user_id: int, folder_id: str) -> str:
    """Directory where original uploaded files are stored."""
    path = os.path.join(UPLOADS_BASE_DIR, str(user_id), folder_id)
    os.makedirs(path, exist_ok=True)
    return path


# ── Meta ──────────────────────────────────────────────────────────────────────

def save_collection_meta(
    collection: str,
    display_name: str,
    user_id: Optional[int] = None,
) -> None:
    import json
    path = _meta_path(collection, user_id)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"display_name": display_name}, f, ensure_ascii=False)


def load_collection_meta(
    folder_name: str,
    user_id: Optional[int] = None,
) -> dict:
    import json
    path = os.path.join(_user_base(user_id), folder_name, "meta.json")
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


# ── Existence / CRUD ──────────────────────────────────────────────────────────

def collection_exists(collection: str, user_id: Optional[int] = None) -> bool:
    p = _store_path(collection, user_id)
    return (
        os.path.isfile(os.path.join(p, "index.faiss"))
        and os.path.isfile(os.path.join(p, "index.pkl"))
    )


def delete_collection(collection: str, user_id: Optional[int] = None) -> None:
    p = _store_path(collection, user_id)
    if os.path.isdir(p):
        shutil.rmtree(p)
    # Also remove uploaded files for this collection
    if user_id is not None:
        up_dir = os.path.join(UPLOADS_BASE_DIR, str(user_id), sanitize_collection_name(collection))
        if os.path.isdir(up_dir):
            shutil.rmtree(up_dir)


def list_collections(user_id: Optional[int] = None) -> List[dict]:
    """Return collections for a user (or all legacy collections if no user_id)."""
    base = _user_base(user_id)
    if not os.path.isdir(base):
        return []
    result = []
    for d in os.listdir(base):
        p = os.path.join(base, d)
        if os.path.isdir(p) and os.path.isfile(os.path.join(p, "index.faiss")):
            meta = load_collection_meta(d, user_id)
            result.append({
                "id":           d,
                "display_name": meta.get("display_name") or d,
            })
    return result


def rename_collection(
    old_collection: str,
    new_display_name: str,
    user_id: Optional[int] = None,
) -> None:
    col = sanitize_collection_name(old_collection)
    if not collection_exists(col, user_id):
        raise FileNotFoundError(f"مجموعه '{old_collection}' پیدا نشد.")
    save_collection_meta(col, new_display_name, user_id)


# ── Load helpers ──────────────────────────────────────────────────────────────

def load_documents(collection: str, user_id: Optional[int] = None) -> List[Document]:
    path = _docs_path(collection, user_id)
    if not os.path.isfile(path):
        return []
    with open(path, "rb") as f:
        return pickle.load(f)


def load_vectorstore(
    collection: str,
    user_id: Optional[int] = None,
) -> Optional[FAISS]:
    col = sanitize_collection_name(collection)
    if not collection_exists(col, user_id):
        return None
    embeddings = BGEEmbeddings.get_instance()
    return FAISS.load_local(
        folder_path=_store_path(col, user_id),
        embeddings=embeddings,
        allow_dangerous_deserialization=True,
    )


# ── File splitter ─────────────────────────────────────────────────────────────

def _make_splitter(chunk_size: int, chunk_overlap: int) -> RecursiveCharacterTextSplitter:
    return RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        separators=["\n\n", "\n", ".", "؟", "!", "؛", "،", " ", ""],
    )


def _load_file(
    path: str,
    fname: str,
    splitter: RecursiveCharacterTextSplitter,
) -> List[Document]:
    ext = os.path.splitext(fname)[1].lower()
    if ext == ".pdf":
        loader = PyPDFLoader(path)
        pages  = loader.load()
        for p in pages:
            p.metadata["source_file"] = fname
        return splitter.split_documents(pages)
    elif ext in (".docx", ".doc"):
        loader = Docx2txtLoader(path)
        pages  = loader.load()
        for p in pages:
            p.metadata["source_file"] = fname
            p.metadata["page"] = ""
        return splitter.split_documents(pages)
    return []


# ── Save uploaded file to permanent storage ───────────────────────────────────

def store_uploaded_file(
    src_path: str,
    filename: str,
    user_id: int,
    folder_id: str,
) -> str:
    """
    Copy *src_path* into the permanent uploads directory.
    Returns the destination path.
    """
    dest_dir  = _uploads_dir(user_id, folder_id)
    dest_path = os.path.join(dest_dir, filename)
    shutil.copy2(src_path, dest_path)
    return dest_path


def list_uploaded_files(user_id: int, folder_id: str) -> List[str]:
    """Return filenames stored in the uploads directory for a collection."""
    up_dir = os.path.join(UPLOADS_BASE_DIR, str(user_id), folder_id)
    if not os.path.isdir(up_dir):
        return []
    return [
        f for f in os.listdir(up_dir)
        if os.path.isfile(os.path.join(up_dir, f))
    ]


def get_uploaded_file_path(user_id: int, folder_id: str, filename: str) -> Optional[str]:
    """Return absolute path if the file exists, else None."""
    path = os.path.join(UPLOADS_BASE_DIR, str(user_id), folder_id, filename)
    return path if os.path.isfile(path) else None


# ── FAISS index builders ──────────────────────────────────────────────────────

def _embed_and_build(
    all_docs: List[Document],
    start_pct: int,
    end_pct: int,
    cb: Callable,
    cancelled: Callable,
) -> FAISS:
    """Embed all_docs and return a FAISS vectorstore."""
    embeddings = BGEEmbeddings.get_instance()
    BATCH  = 32
    texts  = [d.page_content for d in all_docs]
    metas  = [d.metadata     for d in all_docs]
    vectors: List[List[float]] = []
    total_batches = (len(texts) + BATCH - 1) // BATCH

    for b_idx in range(total_batches):
        if cancelled():
            raise InterruptedError("لغو شد.")
        s = b_idx * BATCH
        e = min(s + BATCH, len(texts))
        vectors.extend(embeddings.embed_documents(texts[s:e]))
        pct = start_pct + int((end_pct - start_pct) * (b_idx + 1) / total_batches)
        cb(pct, f"embedding: {e}/{len(texts)} قطعه")

    dim   = len(vectors[0])
    index = faiss_lib.IndexFlatIP(dim)
    index.add(np.array(vectors, dtype="float32"))

    id_map  = {i: str(i) for i in range(len(all_docs))}
    docstore = InMemoryDocstore(
        {str(i): Document(page_content=texts[i], metadata=metas[i]) for i in range(len(all_docs))}
    )
    return FAISS(
        embedding_function=embeddings,
        index=index,
        docstore=docstore,
        index_to_docstore_id=id_map,
    )


def build_vectorstore_from_pdfs(
    pdf_paths: List[str],
    collection: str,
    chunk_size:    int = DEFAULT_CHUNK_SIZE,
    chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
    display_name:  Optional[str] = None,
    progress_callback: ProgressCb  = None,
    cancel_event:      CancelEvent = None,
    user_id: Optional[int] = None,
) -> Tuple[FAISS, int]:
    """Build a fresh FAISS index (overwrites existing collection)."""
    display_name = display_name or collection
    col = sanitize_collection_name(collection)

    def cb(pct: int, detail: str):
        if progress_callback:
            progress_callback(pct, detail)

    def cancelled() -> bool:
        return cancel_event is not None and cancel_event.is_set()

    splitter  = _make_splitter(chunk_size, chunk_overlap)
    all_docs: List[Document] = []

    for i, path in enumerate(pdf_paths):
        if cancelled():
            raise InterruptedError("لغو شد.")
        fname = os.path.basename(path)
        cb(5 + int(25 * i / max(len(pdf_paths), 1)), f"خواندن فایل: {fname}")
        try:
            all_docs.extend(_load_file(path, fname, splitter))
        except Exception as ex:
            print(f"[vectorstore] Error loading {path}: {ex}")

    if not all_docs:
        raise ValueError("هیچ متنی از فایل‌های ارسال‌شده استخراج نشد.")

    cb(30, f"تعداد قطعات: {len(all_docs)} — شروع embedding (BGE-M3)...")

    vs = _embed_and_build(all_docs, 30, 87, cb, cancelled)

    cb(87, "در حال ذخیره در FAISS...")
    store_path = _store_path(col, user_id)
    delete_collection(col, user_id)
    os.makedirs(store_path, exist_ok=True)
    vs.save_local(store_path)

    with open(_docs_path(col, user_id), "wb") as f:
        pickle.dump(all_docs, f)

    save_collection_meta(col, display_name, user_id)
    cb(100, "ایندکس با موفقیت انجام شد ✅")
    return vs, len(all_docs)


def add_files_to_collection(
    pdf_paths: List[str],
    collection: str,
    chunk_size:    int = DEFAULT_CHUNK_SIZE,
    chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
    progress_callback: ProgressCb  = None,
    cancel_event:      CancelEvent = None,
    user_id: Optional[int] = None,
) -> Tuple[FAISS, int]:
    """Append new files to an existing collection (or create it if absent)."""
    col = sanitize_collection_name(collection)

    def cb(pct: int, detail: str):
        if progress_callback:
            progress_callback(pct, detail)

    def cancelled() -> bool:
        return cancel_event is not None and cancel_event.is_set()

    splitter  = _make_splitter(chunk_size, chunk_overlap)
    new_docs: List[Document] = []

    for i, path in enumerate(pdf_paths):
        if cancelled():
            raise InterruptedError("لغو شد.")
        fname = os.path.basename(path)
        cb(5 + int(20 * i / max(len(pdf_paths), 1)), f"خواندن فایل: {fname}")
        try:
            new_docs.extend(_load_file(path, fname, splitter))
        except Exception as ex:
            print(f"[vectorstore] Error loading {path}: {ex}")

    if not new_docs:
        raise ValueError("هیچ متنی از فایل‌های ارسال‌شده استخراج نشد.")

    existing_docs = load_documents(col, user_id) if collection_exists(col, user_id) else []
    new_fnames    = {os.path.basename(d.metadata.get("source_file", "")) for d in new_docs}
    existing_docs = [
        d for d in existing_docs
        if os.path.basename(d.metadata.get("source_file", "")) not in new_fnames
    ]
    all_docs = existing_docs + new_docs
    cb(28, f"تعداد کل قطعات: {len(all_docs)} — شروع embedding...")

    vs = _embed_and_build(all_docs, 28, 87, cb, cancelled)

    cb(87, "در حال ذخیره در FAISS...")
    store_path = _store_path(col, user_id)
    os.makedirs(store_path, exist_ok=True)
    vs.save_local(store_path)
    with open(_docs_path(col, user_id), "wb") as f:
        pickle.dump(all_docs, f)

    meta = load_collection_meta(col, user_id)
    save_collection_meta(col, meta.get("display_name") or collection, user_id)
    cb(100, "فایل‌ها با موفقیت اضافه شدند ✅")
    return vs, len(all_docs)


def delete_file_from_collection(
    collection: str,
    filename:   str,
    user_id: Optional[int] = None,
) -> int:
    """Remove all chunks of *filename*, rebuild index. Returns remaining chunk count."""
    col = sanitize_collection_name(collection)
    if not collection_exists(col, user_id):
        raise FileNotFoundError(f"مجموعه '{collection}' پیدا نشد.")

    docs      = load_documents(col, user_id)
    remaining = [
        d for d in docs
        if os.path.basename(d.metadata.get("source_file", "")) != filename
    ]
    if len(remaining) == len(docs):
        raise FileNotFoundError(f"فایل '{filename}' در این مجموعه یافت نشد.")

    if not remaining:
        delete_collection(col, user_id)
        # Remove from uploads too
        if user_id is not None:
            fp = os.path.join(UPLOADS_BASE_DIR, str(user_id), col, filename)
            if os.path.isfile(fp):
                os.remove(fp)
        return 0

    def _noop_cb(pct, detail): pass
    def _noop_cancel(): return False

    vs = _embed_and_build(remaining, 0, 90, _noop_cb, _noop_cancel)
    store_path = _store_path(col, user_id)
    vs.save_local(store_path)
    with open(_docs_path(col, user_id), "wb") as f:
        pickle.dump(remaining, f)

    meta = load_collection_meta(col, user_id)
    save_collection_meta(col, meta.get("display_name") or col, user_id)

    # Remove from uploads
    if user_id is not None:
        fp = os.path.join(UPLOADS_BASE_DIR, str(user_id), col, filename)
        if os.path.isfile(fp):
            os.remove(fp)

    return len(remaining)
