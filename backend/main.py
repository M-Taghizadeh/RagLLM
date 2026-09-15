"""
RagBot - FastAPI Backend
RESTful API with SSE streaming for all modules + JWT auth + PostgreSQL
"""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.formparsers import MultiPartParser

from routers import chat, rag, article, alerts
from routers import auth as auth_router
from services.llm import (
    DEFAULT_MODEL,
    DEFAULT_OLLAMA_URL,
    DEFAULT_API_BASE_URL,
    DEFAULT_TOP_K,
)

# افزایش ظرفیت آپلود فایل‌های حجیم
MultiPartParser.max_part_size = 500 * 1024 * 1024


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ۱. اتصال به پایگاه داده PostgreSQL
    from services.database import init_db as pg_init
    await pg_init()

    # ۲. راه‌اندازی دیتابیس هشدارهای خبری
    from routers.alerts import init_alerts_db
    init_alerts_db()

    # ۳. بررسی وجود کاربر ادمین
    from services.auth import ensure_admin_exists
    await ensure_admin_exists()

    print("[startup] Backend initialized successfully without startup deadlocks.", flush=True)
    yield


app = FastAPI(
    title="RagBot API",
    description="سامانه هوشمند RAG محلی با FAISS + BGE-M3 + Reranker",
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
        "default_model": DEFAULT_MODEL,
        "ollama_url": DEFAULT_OLLAMA_URL,
        "default_top_k": DEFAULT_TOP_K,
        "api_base_url": DEFAULT_API_BASE_URL or "",
        "api_models": [],
    }


# ── Serve frontend static files ───────────────────────────────────────────────
frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")