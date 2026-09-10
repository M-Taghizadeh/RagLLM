# RagBot v2 — راهنمای Docker

---

## معماری سرویس‌ها

```
                    کلاینت
                       │
                  :7443 (HTTPS)
                       │
              ┌────────▼────────┐
              │      nginx      │  reverse proxy + SSL
              └────────┬────────┘
                       │ :8000 (internal)
              ┌────────▼────────┐
              │     ragbot      │  FastAPI + static frontend
              └───┬─────────┬───┘
                  │         │
         ┌────────▼──┐  ┌───▼────────┐
         │  postgres │  │   ollama   │  host یا profile linux-gpu
         └───────────┘  └────────────┘
```

| سرویس | پورت | توضیح |
|-------|------|-------|
| nginx | **7443→443** | reverse proxy + SSL |
| ragbot | internal :8000 | FastAPI + frontend |
| postgres | internal :5432 | کاربران / سشن / کالکشن |
| ollama | 11434 | فقط با `--profile linux-gpu` (وگرنه Ollama روی host) |

نصب پکیج‌های Python داخل Docker **همان ترتیب SETUP GUIDE** است:
`torch 2.6.0` → `requirements.txt` → `faiss-cpu` (یا `faiss-gpu`).

---

## پیش‌نیازها

| ابزار | توضیح |
|-------|------|
| Docker 24+ | |
| Docker Compose v2.20+ | |
| Ollama | روی host (ویندوز) یا با profile `linux-gpu` |
| NVIDIA Driver + nvidia-container-toolkit | فقط برای GPU |
| `models/bge-m3` | یک‌بار با `scripts/download_embedding.py` |

---

## راه‌اندازی

### مرحله ۱ — دانلود مدل embedding (یک‌بار، روی host)

```bash
pip install huggingface-hub
python scripts/download_embedding.py
```

مدل BGE-M3 (~1.5 GB) در `models/bge-m3/` ذخیره می‌شود و با volume به کانتینر mount می‌شود.

---

### مرحله ۲ — تنظیم .env

```bash
cp .env.example .env
```

```env
# اجرای دستی (uvicorn روی host)
OLLAMA_URL=http://localhost:11434

# کانتینر ragbot این را استفاده می‌کند (compose تزریق می‌کند)
# ویندوز / Ollama روی host:
DOCKER_OLLAMA_URL=http://host.docker.internal:11434
# لینوکس با --profile linux-gpu:
# DOCKER_OLLAMA_URL=http://ollama:11434

POSTGRES_DB=ragbot
POSTGRES_USER=ragbot
POSTGRES_PASSWORD=change_this_password
```

`DATABASE_URL` داخل Compose همیشه به سرویس `postgres` override می‌شود؛ مقدار لوکال `.env` فقط برای اجرای دستی است. Postgres را جداگانه نصب نکنید — compose خودش می‌سازد.

---

### مرحله ۳ — گواهی SSL (یک‌بار)

اگر `nginx/certs/cert.pem` و `key.pem` ندارید:

```bash
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout nginx/certs/key.pem \
  -out nginx/certs/cert.pem \
  -subj "/CN=localhost"
```

---

### مرحله ۴ — اجرا

**ویندوز / بدون GPU container:**
```bash
# Ollama native
ollama serve
ollama pull gemma3:4b

docker compose up -d --build
```

**لینوکس با GPU (Ollama داخل Docker):**
```bash
# در .env: DOCKER_OLLAMA_URL=http://ollama:11434
docker compose --profile linux-gpu up -d --build
docker compose exec ollama ollama pull gemma3:4b
```

**لینوکس + GPU برای embeddings هم:**
```bash
# در .env: USE_CUDA=1 و DOCKER_OLLAMA_URL=http://ollama:11434
USE_CUDA=1 DOCKER_RUNTIME=nvidia \
  docker compose --profile linux-gpu \
  -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

---

### مرحله ۵ — بررسی

```bash
docker compose ps

curl -k https://localhost:7443/api/health
# {"status":"ok","version":"5.0.0","embedding":"bge-m3","vectorstore":"faiss"}
```

سایت: **https://localhost:7443**

لاگین پیش‌فرض: مقادیر `ADMIN_USERNAME` / `ADMIN_PASSWORD` در `.env`.

---

## تغییر مدل LLM

```bash
# در .env
DEFAULT_MODEL=qwen2.5:7b
NUM_CTX=8192

# pull مدل
ollama pull qwen2.5:7b
# یا: docker compose exec ollama ollama pull qwen2.5:7b

docker compose restart ragbot
```

---

## مدیریت داده‌ها

| Volume | محتوا |
|--------|-------|
| `ragbot_postgres_data` | PostgreSQL |
| `ragbot_faiss_data` | ایندکس‌های FAISS |
| `ragbot_sqlite_data` | SQLite alert ها |
| `ragbot_uploads_data` | فایل‌های آپلود |
| `ragbot_ollama_data` | مدل‌های Ollama (profile linux-gpu) |

```bash
docker compose down      # داده‌ها حفظ می‌شوند
docker compose down -v   # ⚠️ volumes هم پاک می‌شوند
```

---

## Troubleshooting

**مدل BGE-M3 پیدا نشد:**
```bash
python scripts/download_embedding.py
```

**Ollama در دسترس نیست:**
```bash
docker compose logs ragbot
# ویندوز: Ollama native + DOCKER_OLLAMA_URL=http://host.docker.internal:11434
# لینوکس GPU: --profile linux-gpu و DOCKER_OLLAMA_URL=http://ollama:11434
```

**Postgres / لاگین کار نمی‌کند:**
```bash
docker compose logs postgres
docker compose logs ragbot
# POSTGRES_PASSWORD در .env باید با مقداری که volume اول ساخته شده یکی باشد
# اگر پسورد را عوض کردید: docker compose down -v  (داده‌ها پاک می‌شود) سپس up دوباره
```

**لاگ زنده:**
```bash
docker compose logs -f ragbot nginx postgres
```
