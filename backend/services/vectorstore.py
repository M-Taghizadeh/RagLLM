"""
Vectorstore Service — FAISS + BM25 corpus on disk.

Layout per collection:
  faiss_db/<collection>/index.faiss
  faiss_db/<collection>/index.pkl
  faiss_db/<collection>/docs.pkl   ← chunk texts for BM25 hybrid retrieval
"""

from __future__ import annotations

import os
import re
import shutil
import hashlib
import pickle
import threading
from typing import List, Tuple, Callable, Optional

import numpy as np
import faiss as faiss_lib
from langchain_core.documents import Document
from langchain_community.document_loaders import PyPDFLoader, Docx2txtLoader
from langchain_community.vectorstores import FAISS
from langchain_community.docstore.in_memory import InMemoryDocstore
from langchain_text_splitters import RecursiveCharacterTextSplitter

from services.embeddings import BGEEmbeddings

STORE_BASE_DIR = os.path.join(os.path.dirname(__file__), "..", "faiss_db")

ProgressCb = Optional[Callable[[int, str], None]]
CancelEvent = Optional[threading.Event]

# Better defaults for Persian / long-form PDFs
DEFAULT_CHUNK_SIZE = 1000
DEFAULT_CHUNK_OVERLAP = 150


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


def _store_path(collection: str) -> str:
    return os.path.join(STORE_BASE_DIR, sanitize_collection_name(collection))


def _docs_path(collection: str) -> str:
    return os.path.join(_store_path(collection), "docs.pkl")


def collection_exists(collection: str) -> bool:
    p = _store_path(collection)
    return (
        os.path.isfile(os.path.join(p, "index.faiss"))
        and os.path.isfile(os.path.join(p, "index.pkl"))
    )


def delete_collection(collection: str) -> None:
    p = _store_path(collection)
    if os.path.isdir(p):
        shutil.rmtree(p)


def list_collections() -> List[str]:
    if not os.path.isdir(STORE_BASE_DIR):
        return []
    result = []
    for d in os.listdir(STORE_BASE_DIR):
        p = os.path.join(STORE_BASE_DIR, d)
        if os.path.isdir(p) and os.path.isfile(os.path.join(p, "index.faiss")):
            result.append(d)
    return result


def load_documents(collection: str) -> List[Document]:
    path = _docs_path(collection)
    if not os.path.isfile(path):
        return []
    with open(path, "rb") as f:
        return pickle.load(f)


def load_vectorstore(collection: str) -> Optional[FAISS]:
    col = sanitize_collection_name(collection)
    p = _store_path(col)
    if not collection_exists(col):
        return None
    embeddings = BGEEmbeddings.get_instance()
    return FAISS.load_local(
        folder_path=p,
        embeddings=embeddings,
        allow_dangerous_deserialization=True,
    )


def _make_splitter(chunk_size: int, chunk_overlap: int) -> RecursiveCharacterTextSplitter:
    return RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        separators=["\n\n", "\n", ".", "؟", "!", "؛", "،", " ", ""],
    )


def _load_file(path: str, fname: str, splitter: RecursiveCharacterTextSplitter) -> List[Document]:
    """Load PDF or Word file and return split documents."""
    ext = os.path.splitext(fname)[1].lower()
    if ext == ".pdf":
        loader = PyPDFLoader(path)
        pages = loader.load()
        for p in pages:
            p.metadata["source_file"] = fname
        return splitter.split_documents(pages)
    elif ext in (".docx", ".doc"):
        loader = Docx2txtLoader(path)
        pages = loader.load()
        for p in pages:
            p.metadata["source_file"] = fname
            p.metadata["page"] = ""
        return splitter.split_documents(pages)
    return []


def build_vectorstore_from_pdfs(
    pdf_paths: List[str],
    collection: str,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
    progress_callback: ProgressCb = None,
    cancel_event: CancelEvent = None,
) -> Tuple[FAISS, int]:
    collection = sanitize_collection_name(collection)

    def cb(pct: int, detail: str):
        if progress_callback:
            progress_callback(pct, detail)

    def cancelled() -> bool:
        return cancel_event is not None and cancel_event.is_set()

    splitter = _make_splitter(chunk_size, chunk_overlap)

    all_docs: List[Document] = []
    for i, path in enumerate(pdf_paths):
        if cancelled():
            raise InterruptedError("لغو شد.")
        fname = os.path.basename(path)
        cb(5 + int(25 * i / max(len(pdf_paths), 1)), f"خواندن فایل: {fname}")
        try:
            docs = _load_file(path, fname, splitter)
            all_docs.extend(docs)
        except Exception as e:
            print(f"[vectorstore] Error loading {path}: {e}")

    if not all_docs:
        raise ValueError("هیچ متنی از فایل‌های ارسال‌شده استخراج نشد.")

    cb(30, f"تعداد قطعات: {len(all_docs)} — شروع embedding (BGE-M3)...")

    embeddings = BGEEmbeddings.get_instance()
    BATCH = 32
    texts = [d.page_content for d in all_docs]
    metas = [d.metadata for d in all_docs]
    vectors: List[List[float]] = []

    total_batches = (len(texts) + BATCH - 1) // BATCH
    for b_idx in range(total_batches):
        if cancelled():
            raise InterruptedError("لغو شد.")
        start = b_idx * BATCH
        end = min(start + BATCH, len(texts))
        vectors.extend(embeddings.embed_documents(texts[start:end]))
        pct = 30 + int(55 * (b_idx + 1) / total_batches)
        cb(pct, f"embedding: {end}/{len(texts)} قطعه")

    cb(87, "در حال ذخیره در FAISS...")

    dim = len(vectors[0])
    index = faiss_lib.IndexFlatIP(dim)
    index.add(np.array(vectors, dtype="float32"))

    index_to_docstore_id = {i: str(i) for i in range(len(all_docs))}
    docstore = InMemoryDocstore(
        {
            str(i): Document(page_content=texts[i], metadata=metas[i])
            for i in range(len(all_docs))
        }
    )

    vs = FAISS(
        embedding_function=embeddings,
        index=index,
        docstore=docstore,
        index_to_docstore_id=index_to_docstore_id,
    )

    store_path = _store_path(collection)
    delete_collection(collection)
    os.makedirs(store_path, exist_ok=True)
    vs.save_local(store_path)

    with open(_docs_path(collection), "wb") as f:
        pickle.dump(all_docs, f)

    cb(100, "ایندکس با موفقیت انجام شد ✅")
    return vs, len(all_docs)
