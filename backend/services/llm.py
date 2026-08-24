"""
LLM Service - shared ChatOllama instance management
All functions check Ollama availability and raise clear errors.
"""

import os
import requests
from pathlib import Path
from langchain_ollama import ChatOllama
from fastapi import HTTPException

# Load .env from project root (two levels up from this file)
_env_path = Path(__file__).resolve().parents[2] / ".env"
if _env_path.exists():
    for _line in _env_path.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

DEFAULT_OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
DEFAULT_MODEL      = os.environ.get("DEFAULT_MODEL", "qwen2.5:14b")
DEFAULT_TOP_K      = int(os.environ.get("DEFAULT_TOP_K", "8"))

# Cache: (base_url, model, temperature) -> ChatOllama
_cache: dict = {}


def check_ollama(base_url: str = DEFAULT_OLLAMA_URL) -> bool:
    """Return True if Ollama is reachable, False otherwise."""
    try:
        resp = requests.get(f"{base_url.rstrip('/')}/api/tags", timeout=3)
        return resp.status_code == 200
    except Exception:
        return False


def assert_ollama(base_url: str = DEFAULT_OLLAMA_URL) -> None:
    """Raise a clear HTTP 503 if Ollama is not running."""
    if not check_ollama(base_url):
        raise HTTPException(
            status_code=503,
            detail=(
                f"سرور Ollama در دسترس نیست ({base_url}). "
                "لطفاً Ollama را اجرا کنید: 'ollama serve'"
            ),
        )


def get_llm(
    base_url: str = DEFAULT_OLLAMA_URL,
    model: str = DEFAULT_MODEL,
    temperature: float = 0.3,
) -> ChatOllama:
    """Get a cached ChatOllama instance. Raises 503 if Ollama is down."""
    assert_ollama(base_url)
    key = (base_url, model, temperature)
    if key not in _cache:
        _cache[key] = ChatOllama(
            base_url=base_url,
            model=model,
            temperature=temperature,
        )
    return _cache[key]


def list_ollama_models(base_url: str = DEFAULT_OLLAMA_URL) -> list[str]:
    """Return installed model names. Returns empty list if Ollama is down."""
    try:
        resp = requests.get(f"{base_url.rstrip('/')}/api/tags", timeout=5)
        resp.raise_for_status()
        return sorted(m["name"] for m in resp.json().get("models", []))
    except Exception:
        return []
