# ── RagBot v2 — Backend Dockerfile ──────────────────────────────────────────
# CPU:  docker compose up -d --build
# GPU:  USE_CUDA=1 DOCKER_RUNTIME=nvidia docker compose up -d --build
# ─────────────────────────────────────────────────────────────────────────────

ARG USE_CUDA=0
ARG PYTHON_VERSION=3.11

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM python:${PYTHON_VERSION}-slim AS builder

ARG USE_CUDA
ARG TORCH_CUDA_VERSION=cu124

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential gcc g++ libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./requirements.txt

RUN pip install --upgrade pip && \
    if [ "$USE_CUDA" = "1" ]; then \
        pip install --no-cache-dir --prefix=/install \
            "torch==2.6.0" "torchvision==0.21.0" "torchaudio==2.6.0" \
            --index-url https://download.pytorch.org/whl/${TORCH_CUDA_VERSION} && \
        pip install --no-cache-dir --prefix=/install faiss-gpu ; \
    else \
        pip install --no-cache-dir --prefix=/install \
            "torch==2.6.0" "torchvision==0.21.0" "torchaudio==2.6.0" \
            --index-url https://download.pytorch.org/whl/cpu ; \
    fi && \
    pip install --no-cache-dir --prefix=/install --no-deps sentence-transformers && \
    pip install --no-cache-dir --prefix=/install -r requirements.txt

# ── Stage 2: runtime (همیشه python:slim — GPU از طریق nvidia runtime میاد) ──
FROM python:${PYTHON_VERSION}-slim AS final

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /install /usr/local

LABEL maintainer="RagBot"
LABEL description="RagBot v2 — Hybrid RAG with FAISS + BGE-M3 + Ollama"

WORKDIR /app

COPY backend/  ./backend/
COPY frontend/ ./frontend/
COPY scripts/  ./scripts/

RUN mkdir -p ./models/bge-m3 ./backend/faiss_db ./data \
 && chmod -R 755 ./backend

RUN useradd -m -u 1000 ragbot \
 && chown -R ragbot:ragbot /app
USER ragbot

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

WORKDIR /app/backend

CMD ["python", "-m", "uvicorn", "main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "1", \
     "--log-level", "info"]
