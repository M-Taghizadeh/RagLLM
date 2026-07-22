"""
RagBot - FastAPI Backend
RESTful API with SSE streaming for all 4 modules
"""

import sqlite3
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from routers import chat, rag, article, alerts

# ── Fix: increase multipart part size to 500MB for PDF uploads ──────────────
# Starlette 0.46 uses MultiPartParser.max_part_size (default 1MB) — override it
from starlette.formparsers import MultiPartParser
MultiPartParser.max_part_size = 500 * 1024 * 1024  # 500 MB

DB_PATH = os.path.join(os.path.dirname(__file__), "ragbot.db")


def init_db():
    """Initialize SQLite database with required tables."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    # Alert rules table
    c.execute("""
        CREATE TABLE IF NOT EXISTS alert_rules (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            category    TEXT NOT NULL,
            keywords    TEXT NOT NULL,
            description TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Alert results table — stores scan results
    c.execute("""
        CREATE TABLE IF NOT EXISTS alert_results (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id     INTEGER NOT NULL,
            source_url  TEXT NOT NULL,
            title       TEXT,
            excerpt     TEXT,
            matched_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
        )
    """)

    conn.commit()
    conn.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # Pre-warm BGE-M3 embedding model on startup
    import threading

    def _warm_embeddings():
        try:
            from services.embeddings import BGEEmbeddings

            e = BGEEmbeddings.get_instance()
            e.embed_query("warmup")
            print("[startup] BGE-M3 embedding model loaded and ready.")
        except Exception as ex:
            print(f"[startup] Warning: could not pre-load BGE-M3: {ex}")

    threading.Thread(target=_warm_embeddings, daemon=True).start()
    yield


app = FastAPI(
    title="RagBot API",
    description="سامانه RAG محلی با FAISS + BGE-M3 + Ollama",
    version="4.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount routers
app.include_router(chat.router,    prefix="/api/chat",    tags=["Chat"])
app.include_router(rag.router,     prefix="/api/rag",     tags=["RAG"])
app.include_router(article.router, prefix="/api/article", tags=["Article"])
app.include_router(alerts.router,  prefix="/api/alerts",  tags=["Alerts"])

@app.get("/api/health")
def health():
    return {"status": "ok", "version": "4.0.0", "embedding": "bge-m3", "vectorstore": "faiss"}


# Serve frontend static files — mount LAST so /api/* routes take priority
frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")
