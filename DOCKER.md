# RagBot v2 — راهنمای Docker

---

## معماری سرویس‌ها

```
                    اینترنت
                       │
                  80 / 443
                       │
              ┌────────▼────────┐
              │      nginx      │  reverse proxy + SSL
              └────────┬────────┘
                       │ :8000 (internal)
              ┌────────▼────────┐
              │     ragbot      │  FastAPI + static frontend
              └────────┬────────┘
                       │ :11434
              ┌────────▼────────┐
              │     ollama      │  LLM server (linux-gpu profile)
              └─────────────────┘
```

| سرویس | پورت | توضیح |
|-------|------|-------|
| nginx | 80, 443 | reverse proxy، SSL termination، redirect HTTP→HTTPS |
| ragbot | internal :8000 | FastAPI + frontend static files |
| ollama | 11434 | LLM server — فقط با `--profile linux-gpu` |

---

## پیش‌نیازها

| ابزار | توضیح |
|-------|-------|
| Docker 24+ | |
| Docker Compose v2.20+ | |
| NVIDIA Driver + nvidia-container-toolkit | فقط برای GPU |

---

## راه‌اندازی

### مرحله ۱ — دانلود مدل embedding (یک‌بار)

```bash
pip install huggingface-hub
python scripts/download_embedding.py
```

مدل BGE-M3 (~1.5 GB) در `models/bge-m3/` ذخیره می‌شود.

---

### مرحله ۲ — تنظیم .env

```bash
cp .env.example .env
```

متغیرهای مهم Ollama:

```env
# برای اجرای دستی (uvicorn روی host)
OLLAMA_URL=http://localhost:11434

# آدرسی که کانتینر ragbot واقعاً استفاده می‌کند (compose این را تزریق می‌کند)
# ویندوز / Ollama روی host:
DOCKER_OLLAMA_URL=http://host.docker.internal:11434
# لینوکس با --profile linux-gpu:
# DOCKER_OLLAMA_URL=http://ollama:11434
```

`DATABASE_URL` داخل Compose همیشه به سرویس `postgres` override می‌شود؛ مقدار لوکال `.env` فقط برای اجرای دستی است.

---

### مرحله ۳ — اجرا

**لینوکس با GPU (ollama داخل Docker):**
```bash
docker compose --profile linux-gpu up -d --build
```

**ویندوز / بدون GPU container:**
```bash
# ابتدا Ollama را به‌صورت native اجرا کنید
ollama serve

# سپس
docker compose up -d --build
```

---

### مرحله ۴ — pull کردن مدل LLM (اولین بار)

```bash
docker compose exec ollama ollama pull gemma3:4b
# یا هر مدل دیگری
docker compose exec ollama ollama pull qwen2.5:7b
```

روی ویندوز:
```bash
ollama pull gemma3:4b
```

---

### مرحله ۵ — بررسی

```bash
docker compose ps

# health check مستقیم
curl -k https://localhost/api/health
# {"status":"ok","version":"4.0.0","embedding":"bge-m3","vectorstore":"faiss"}
```

سایت روی **https://\<server-ip\>** یا **https://localhost** در دسترس است.

---

## SSL

فایل‌های `nginx/certs/cert.pem` و `nginx/certs/key.pem` باید موجود باشند.

**Self-signed (تست):**
```bash
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout nginx/certs/key.pem \
  -out nginx/certs/cert.pem \
  -subj "/CN=localhost"
```

**Let's Encrypt (production):**
گواهی را از certbot بگیرید و مسیر فایل‌ها را در `nginx.conf` تنظیم کنید.

---

## تغییر مدل LLM

```bash
# در .env
DEFAULT_MODEL=qwen2.5:7b
NUM_CTX=8192

# pull مدل جدید
docker compose exec ollama ollama pull qwen2.5:7b

# restart برای اعمال config
docker compose restart ragbot
```

---

## GPU برای BGE-M3 embeddings

برای اینکه ragbot هم از GPU برای embeddings استفاده کند:

```bash
# در .env اضافه کنید
USE_CUDA=1

# rebuild
docker compose --profile linux-gpu up -d --build
```

---

## مدیریت داده‌ها

| Volume | محتوا |
|--------|-------|
| `ragbot_ollama_data` | مدل‌های Ollama |
| `ragbot_faiss_data` | ایندکس‌های FAISS |
| `ragbot_sqlite_data` | پایگاه داده alert ها (`DB_PATH`) |
| `ragbot_postgres_data` | PostgreSQL (کاربران / سشن / کالکشن) |
| `ragbot_uploads_data` | فایل‌های آپلودشده |

```bash
# بکاپ FAISS
docker run --rm \
  -v ragbot_faiss_data:/data \
  -v $(pwd)/backup:/backup \
  alpine tar czf /backup/faiss_$(date +%Y%m%d).tar.gz -C /data .
```

---

## متوقف کردن

```bash
# توقف (داده‌ها حفظ می‌شوند)
docker compose down

# توقف + حذف volumes (⚠️ داده‌ها از بین می‌رود)
docker compose down -v
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
# داخل کانتینر باید DOCKER_OLLAMA_URL به host یا سرویس ollama برسد
# ویندوز: Ollama native + DOCKER_OLLAMA_URL=http://host.docker.internal:11434
# لینوکس GPU: docker compose --profile linux-gpu ... و DOCKER_OLLAMA_URL=http://ollama:11434
```

**لاگ‌های زنده:**
```bash
docker compose logs -f ragbot
docker compose logs -f nginx
```
