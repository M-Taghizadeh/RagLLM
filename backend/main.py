"""
RagBot - FastAPI Backend
RESTful API with SSE streaming for all 4 modules + JWT auth + PostgreSQL
"""

import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from routers import chat, rag, article, alerts
from routers import auth as auth_router
from services.llm import (
    DEFAULT_MODEL,
    DEFAULT_OLLAMA_URL,
    DEFAULT_API_BASE_URL,
    DEFAULT_TOP_K,
)

# ── Fix: increase multipart part size to 500 MB for PDF uploads ──────────────
from starlette.formparsers import MultiPartParser
MultiPartParser.max_part_size = 500 * 1024 * 1024


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1. Init PostgreSQL tables
    from services.database import init_db as pg_init
    await pg_init()

    # 2. Ensure default admin account exists
    from services.auth import ensure_admin_exists
    await ensure_admin_exists()

    # 3. Pre-warm BGE-M3 embedding model
    def _warm():
        try:
            from services.embeddings import BGEEmbeddings
            BGEEmbeddings.get_instance().embed_query("warmup")
            print("[startup] BGE-M3 embedding model loaded and ready.")
        except Exception as ex:
            print(f"[startup] Warning: could not pre-load BGE-M3: {ex}")

    threading.Thread(target=_warm, daemon=True).start()
    yield


app = FastAPI(
    title="RagBot API",
    description="سامانه RAG محلی با FAISS + BGE-M3 + Ollama",
    version="5.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(auth_router.router, prefix="/api/auth",    tags=["Auth"])
app.include_router(chat.router,        prefix="/api/chat",    tags=["Chat"])
app.include_router(rag.router,         prefix="/api/rag",     tags=["RAG"])
app.include_router(article.router,     prefix="/api/article", tags=["Article"])
app.include_router(alerts.router,      prefix="/api/alerts",  tags=["Alerts"])


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "5.0.0", "embedding": "bge-m3", "vectorstore": "faiss"}


@app.get("/api/config")
def get_config():
    return {
        "default_model":   DEFAULT_MODEL,
        "ollama_url":      DEFAULT_OLLAMA_URL,
        "default_top_k":   DEFAULT_TOP_K,
        "api_base_url":    DEFAULT_API_BASE_URL or "",
        "api_models":      [],
    }


# ── Serve frontend static files (mount LAST) ─────────────────────────────────
frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")
