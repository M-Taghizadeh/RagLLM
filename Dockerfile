# ── RagBot v2 — Dockerfile ───────────────────────────────────────────────────
# Mirrors SETUP GUIDE.txt install order exactly:
#   1) torch (+ vision/audio) from PyTorch index (cu124 or cpu)
#   2) pip install -r requirements.txt
#   3) faiss-cpu / faiss-gpu
# Then re-pins torch so no transitive dep can replace the wheel.
#
# CPU:  docker compose up -d --build
# GPU:  USE_CUDA=1 DOCKER_RUNTIME=nvidia \
#         docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
# ─────────────────────────────────────────────────────────────────────────────

ARG USE_CUDA=0
ARG PYTHON_VERSION=3.11

# ── Stage 1: builder (venv, same as manual) ──────────────────────────────────
FROM python:${PYTHON_VERSION}-slim AS builder

ARG USE_CUDA
ARG TORCH_CUDA_VERSION=cu124

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential gcc g++ libgomp1 \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY backend/requirements.txt ./requirements.txt

RUN pip install --upgrade pip setuptools wheel && \
    if [ "$USE_CUDA" = "1" ]; then \
        TORCH_INDEX="https://download.pytorch.org/whl/${TORCH_CUDA_VERSION}" ; \
    else \
        TORCH_INDEX="https://download.pytorch.org/whl/cpu" ; \
    fi && \
    pip install --no-cache-dir \
        "torch==2.6.0" "torchvision==0.21.0" "torchaudio==2.6.0" \
        --index-url "${TORCH_INDEX}" && \
    pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir --force-reinstall --no-deps \
        "torch==2.6.0" "torchvision==0.21.0" "torchaudio==2.6.0" \
        --index-url "${TORCH_INDEX}" && \
    if [ "$USE_CUDA" = "1" ]; then \
        pip install --no-cache-dir faiss-gpu ; \
    else \
        pip install --no-cache-dir faiss-cpu ; \
    fi

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM python:${PYTHON_VERSION}-slim AS final

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

LABEL maintainer="RagBot"
LABEL description="RagBot v2 — Hybrid RAG + Auth + PostgreSQL"

WORKDIR /app

COPY backend/  ./backend/
COPY frontend/ ./frontend/
COPY scripts/  ./scripts/

RUN mkdir -p \
    ./models/bge-m3 \
    ./backend/faiss_db \
    ./data \
    ./data/uploads \
    && chmod -R 755 ./backend ./data

RUN useradd -m -u 1000 ragbot \
 && chown -R ragbot:ragbot /app
USER ragbot

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

WORKDIR /app/backend

CMD ["python", "-m", "uvicorn", "main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "1", \
     "--log-level", "info"]
