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
import gc
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Callable, List, Optional, Tuple

# تضمین حالت آفلاین در تمام زیرماژول‌های ترنسفورمرز
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

import numpy as np
import faiss as faiss_lib
from langchain_core.documents import Document
from langchain_community.document_loaders import PyPDFLoader, Docx2txtLoader
from langchain_community.vectorstores import FAISS
from langchain_community.docstore.in_memory import InMemoryDocstore
from langchain_text_splitters import RecursiveCharacterTextSplitter

from services import memory
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
    invalidate_index_cache(collection, user_id)
    p = _store_path(collection, user_id)
    if os.path.isdir(p):
        shutil.rmtree(p)
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
        print(f"--> [VECTORSTORE] Collection '{col}' does not exist on disk.", flush=True)
        return None
    
    print(f"--> [VECTORSTORE] Getting BGEEmbeddings instance...", flush=True)
    embeddings = BGEEmbeddings.get_instance()
    
    store_dir = _store_path(col, user_id)
    print(f"--> [VECTORSTORE] Executing FAISS.load_local from {store_dir}...", flush=True)
    
    vs = FAISS.load_local(
        folder_path=store_dir,
        embeddings=embeddings,
        allow_dangerous_deserialization=True,
    )
    print("--> [VECTORSTORE] FAISS.load_local finished successfully!", flush=True)
    return vs


# ── In-memory index cache ─────────────────────────────────────────────────────
# Loading FAISS + docs.pkl and building BM25 is expensive, so each collection is
# loaded once and reused. Entries are keyed by the on-disk file signature, so a
# re-index / add / delete is picked up automatically on the next query.

# Memory limits are derived at runtime from the server / container RAM (services.memory):
# the cache never exceeds its share of RAM, and indexes are evicted (LRU first) whenever
# free memory drops below the safety reserve.
_INDEX_IDLE_SECONDS = 60 * 60
_MAX_CACHED_INDEXES = 64


class IndexMemoryError(RuntimeError):
    pass


def _estimate_load_bytes(col: str, user_id: Optional[int]) -> int:
    """Pre-load estimate from file sizes (pickled text expands ~4x once loaded + BM25)."""
    p = _store_path(col, user_id)
    total = 0
    for name, factor in (("index.faiss", 1), ("index.pkl", 2), ("docs.pkl", 4)):
        try:
            total += os.path.getsize(os.path.join(p, name)) * factor
        except OSError:
            pass
    return total


def _estimate_index_bytes(vs, docs) -> int:
    vec_bytes = 0
    try:
        vec_bytes = int(vs.index.ntotal) * int(vs.index.d) * 4
    except Exception:
        pass
    text_bytes = sum(len(d.page_content) for d in docs) if docs else 0
    # Text lives in docs + FAISS docstore + BM25 token lists (≈4 copies incl. Python overhead).
    return vec_bytes + text_bytes * 4


class LoadedIndex:
    __slots__ = ("vectorstore", "documents", "bm25", "signature", "size_bytes", "last_used")

    def __init__(self, vectorstore, documents, bm25, signature):
        self.vectorstore = vectorstore
        self.documents = documents
        self.bm25 = bm25
        self.signature = signature
        self.size_bytes = _estimate_index_bytes(vectorstore, documents)
        self.last_used = time.monotonic()


_index_cache: "OrderedDict[tuple, LoadedIndex]" = OrderedDict()
_index_cache_lock = threading.Lock()
_index_key_locks: dict[tuple, threading.Lock] = {}


def _index_signature(col: str, user_id: Optional[int]) -> tuple:
    p = _store_path(col, user_id)
    sig = []
    for name in ("index.faiss", "index.pkl", "docs.pkl"):
        try:
            st = os.stat(os.path.join(p, name))
            sig.append((st.st_mtime_ns, st.st_size))
        except OSError:
            sig.append(None)
    return tuple(sig)


def _evict_locked(keep: Optional[tuple] = None, need_bytes: int = 0) -> int:
    """
    Caller holds _index_cache_lock. `keep` (in use right now) is never evicted.
    Returns bytes released. Requests already holding an evicted index keep working;
    its memory is freed when they finish.
    """
    now = time.monotonic()
    released = 0
    for k in [k for k, e in _index_cache.items() if k != keep and now - e.last_used > _INDEX_IDLE_SECONDS]:
        released += _index_cache.pop(k).size_bytes

    budget = memory.cache_budget_bytes()
    reserve = memory.reserve_bytes()
    while _index_cache:
        cached = sum(e.size_bytes for e in _index_cache.values())
        headroom = memory.available_bytes() + released - need_bytes
        if cached <= budget and headroom >= reserve and len(_index_cache) <= _MAX_CACHED_INDEXES:
            break
        victim = next((k for k in _index_cache if k != keep), None)
        if victim is None:
            break
        released += _index_cache.pop(victim).size_bytes
        print(f"--> [VECTORSTORE] Evicted index {victim} from cache (memory)", flush=True)
    if released:
        gc.collect()
    return released


def _cached_entry(key: tuple, signature: tuple) -> Optional[LoadedIndex]:
    with _index_cache_lock:
        entry = _index_cache.get(key)
        if entry is not None and entry.signature == signature:
            entry.last_used = time.monotonic()
            _index_cache.move_to_end(key)
            _evict_locked(keep=key)
            return entry
    return None


def is_index_cached(collection: str, user_id: Optional[int] = None) -> bool:
    col = sanitize_collection_name(collection)
    return _cached_entry((user_id, col), _index_signature(col, user_id)) is not None


def invalidate_index_cache(collection: str, user_id: Optional[int] = None) -> None:
    col = sanitize_collection_name(collection)
    with _index_cache_lock:
        _index_cache.pop((user_id, col), None)


def get_loaded_index(collection: str, user_id: Optional[int] = None) -> Optional[LoadedIndex]:
    """Blocking; call from a worker thread. Concurrent callers share a single load."""
    from langchain_community.retrievers import BM25Retriever
    from services.text_normalize import persian_tokenize

    col = sanitize_collection_name(collection)
    key = (user_id, col)
    signature = _index_signature(col, user_id)
    entry = _cached_entry(key, signature)
    if entry is not None:
        return entry

    with _index_cache_lock:
        key_lock = _index_key_locks.setdefault(key, threading.Lock())

    with key_lock:
        signature = _index_signature(col, user_id)
        entry = _cached_entry(key, signature)
        if entry is not None:
            return entry

        need = _estimate_load_bytes(col, user_id)
        with _index_cache_lock:
            _index_cache.pop(key, None)
            released = _evict_locked(keep=None, need_bytes=need)
        if memory.available_bytes() + released - need < memory.reserve_bytes() // 2:
            raise IndexMemoryError(
                "حافظه سرور برای بارگذاری این پایگاه دانش کافی نیست. "
                "چند لحظه بعد دوباره تلاش کنید یا پایگاه دانش را کوچک‌تر کنید."
            )

        vs = load_vectorstore(col, user_id=user_id)
        if vs is None:
            return None
        docs = load_documents(col, user_id=user_id)
        bm25 = BM25Retriever.from_documents(docs, preprocess_func=persian_tokenize) if docs else None
        entry = LoadedIndex(vs, docs, bm25, signature)

        with _index_cache_lock:
            _index_cache[key] = entry
            _evict_locked(keep=key)
            # Too big to keep alongside everything else: serve this request, then let it go.
            if memory.available_bytes() < memory.reserve_bytes():
                _index_cache.pop(key, None)
        print(
            f"--> [VECTORSTORE] Loaded index '{col}' (user={user_id}, docs={len(docs)}, "
            f"~{entry.size_bytes / 1048576:.0f} MB, free RAM {memory.available_bytes() / 1048576:.0f} MB)",
            flush=True,
        )
        return entry


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
        try:
            loader = Docx2txtLoader(path)
            pages  = loader.load()
        except Exception as docx_err:
            if ext == ".doc":
                raise ValueError(
                    f"فایل '{fname}' از نوع .doc (Word قدیمی) است و قابل خواندن نیست. "
                    "لطفاً آن را به فرمت .docx تبدیل کرده و مجدداً آپلود کنید."
                ) from docx_err
            raise
        for p in pages:
            p.metadata["source_file"] = fname
            p.metadata["page"] = ""
        chunks = splitter.split_documents(pages)
        if not chunks:
            raise ValueError(
                f"فایل '{fname}' هیچ متنی قابل استخراج ندارد. "
                "ممکن است فایل محافظت‌شده یا خراب باشد."
            )
        return chunks
    return []


# ── Save uploaded file to permanent storage ───────────────────────────────────

def store_uploaded_file(
    src_path: str,
    filename: str,
    user_id: int,
    folder_id: str,
) -> str:
    dest_dir  = _uploads_dir(user_id, folder_id)
    dest_path = os.path.join(dest_dir, filename)
    shutil.copy2(src_path, dest_path)
    return dest_path


def list_uploaded_files(user_id: int, folder_id: str) -> List[str]:
    up_dir = os.path.join(UPLOADS_BASE_DIR, str(user_id), folder_id)
    if not os.path.isdir(up_dir):
        return []
    return [
        f for f in os.listdir(up_dir)
        if os.path.isfile(os.path.join(up_dir, f))
    ]


def get_uploaded_file_path(user_id: int, folder_id: str, filename: str) -> Optional[str]:
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
            print(f"[vectorstore] Error loading {path}: {ex}", flush=True)
            cb(5 + int(25 * i / max(len(pdf_paths), 1)), f"⚠️ خطا در خواندن '{fname}': {ex}")
            if len(pdf_paths) == 1:
                raise

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
    cb(100, "با موفقیت ذخیره شد ✅")
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
            print(f"[vectorstore] Error loading {path}: {ex}", flush=True)
            cb(5 + int(20 * i / max(len(pdf_paths), 1)), f"⚠️ خطا در خواندن '{fname}': {ex}")
            if len(pdf_paths) == 1:
                raise

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

    if user_id is not None:
        fp = os.path.join(UPLOADS_BASE_DIR, str(user_id), col, filename)
        if os.path.isfile(fp):
            os.remove(fp)

    return len(remaining)