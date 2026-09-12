"""
LLM Service - Ollama + OpenAI-compatible API providers.
"""

import json
import os
import asyncio
from pathlib import Path
from typing import Any, AsyncIterator, Iterable, List, Optional, Union

import requests
from fastapi import HTTPException
from langchain_ollama import ChatOllama
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage

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
DENSE_WEIGHT       = float(os.environ.get("DENSE_WEIGHT", "0.7"))
SPARSE_WEIGHT      = float(os.environ.get("SPARSE_WEIGHT", "0.3"))
DEFAULT_NUM_CTX    = int(os.environ.get("NUM_CTX", "8192"))

DEFAULT_API_BASE_URL = os.environ.get("API_BASE_URL", "")

# Optional catalog from env is intentionally empty — models come from the API or user input
DEFAULT_API_MODELS: dict[str, str] = {}

_cache: dict = {}


# ── Helpers ────────────────────────────────────────────────────────────────────

def _normalize_provider(provider: Optional[str]) -> str:
    p = (provider or "ollama").strip().lower()
    if p in ("api", "openai", "openai_compatible", "remote"):
        return "api"
    return "ollama"


def _msg_role(msg: Any) -> str:
    if isinstance(msg, SystemMessage) or getattr(msg, "type", None) == "system":
        return "system"
    if isinstance(msg, AIMessage) or getattr(msg, "type", None) == "ai":
        return "assistant"
    return "user"


def _msg_content(msg: Any) -> str:
    if hasattr(msg, "content"):
        c = msg.content
        return c if isinstance(c, str) else str(c)
    return str(msg)


def _to_openai_messages(messages: Iterable[Any]) -> List[dict]:
    return [{"role": _msg_role(m), "content": _msg_content(m)} for m in messages]


class _SimpleChunk:
    __slots__ = ("content",)

    def __init__(self, content: str):
        self.content = content


class OpenAICompatLLM:
    """Minimal OpenAI-compatible chat client with astream/ainvoke."""

    def __init__(
        self,
        base_url: str,
        model: str,
        api_token: str,
        temperature: float = 0.3,
        timeout: int = 180,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_token = api_token or ""
        self.temperature = temperature
        self.timeout = timeout

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self.api_token:
            h["Authorization"] = f"Bearer {self.api_token}"
        return h

    def _payload(self, messages: Iterable[Any], stream: bool) -> dict:
        return {
            "model": self.model,
            "messages": _to_openai_messages(messages),
            "temperature": self.temperature,
            "stream": stream,
        }

    def _chat_url(self) -> str:
        base = self.base_url
        if base.endswith("/v1"):
            return f"{base}/chat/completions"
        return f"{base}/v1/chat/completions"

    async def astream(self, messages: Iterable[Any]) -> AsyncIterator[_SimpleChunk]:
        loop = asyncio.get_event_loop()
        queue: asyncio.Queue = asyncio.Queue()
        sentinel = object()

        def _run():
            try:
                with requests.post(
                    self._chat_url(),
                    headers=self._headers(),
                    json=self._payload(messages, stream=True),
                    stream=True,
                    timeout=self.timeout,
                ) as resp:
                    if resp.status_code >= 400:
                        try:
                            detail = resp.json()
                        except Exception:
                            detail = resp.text
                        raise RuntimeError(f"API error {resp.status_code}: {detail}")
                    for raw in resp.iter_lines(decode_unicode=True):
                        if not raw:
                            continue
                        line = raw.strip()
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            obj = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        choices = obj.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta") or {}
                        token = delta.get("content") or ""
                        if not token:
                            # some providers send full message chunks
                            msg = choices[0].get("message") or {}
                            token = msg.get("content") or ""
                        if token:
                            loop.call_soon_threadsafe(queue.put_nowait, token)
            except Exception as e:
                loop.call_soon_threadsafe(queue.put_nowait, e)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, sentinel)

        asyncio.create_task(asyncio.to_thread(_run))

        while True:
            item = await queue.get()
            if item is sentinel:
                break
            if isinstance(item, Exception):
                raise item
            yield _SimpleChunk(item)

    async def ainvoke(self, messages: Iterable[Any]) -> _SimpleChunk:
        def _call():
            resp = requests.post(
                self._chat_url(),
                headers=self._headers(),
                json=self._payload(messages, stream=False),
                timeout=self.timeout,
            )
            if resp.status_code >= 400:
                try:
                    detail = resp.json()
                except Exception:
                    detail = resp.text
                raise RuntimeError(f"API error {resp.status_code}: {detail}")
            data = resp.json()
            choices = data.get("choices") or []
            if not choices:
                return ""
            msg = choices[0].get("message") or {}
            return msg.get("content") or ""

        content = await asyncio.to_thread(_call)
        return _SimpleChunk(content)


# ── Availability ───────────────────────────────────────────────────────────────

def check_ollama(base_url: str = DEFAULT_OLLAMA_URL) -> bool:
    try:
        resp = requests.get(f"{base_url.rstrip('/')}/api/tags", timeout=3)
        return resp.status_code == 200
    except Exception:
        return False


def check_api(base_url: str, api_token: str = "") -> bool:
    """Best-effort health check for OpenAI-compatible APIs."""
    try:
        url = base_url.rstrip("/")
        if not url.endswith("/models"):
            url = f"{url}/models" if url.endswith("/v1") else f"{url}/v1/models"
        headers = {}
        if api_token:
            headers["Authorization"] = f"Bearer {api_token}"
        resp = requests.get(url, headers=headers, timeout=5)
        return resp.status_code < 500
    except Exception:
        return False


def assert_llm_ready(
    provider: str = "ollama",
    ollama_url: str = DEFAULT_OLLAMA_URL,
    api_base_url: str = DEFAULT_API_BASE_URL,
    api_token: str = "",
) -> None:
    provider = _normalize_provider(provider)
    if provider == "api":
        if not (api_base_url or "").strip():
            raise HTTPException(status_code=400, detail="آدرس API تنظیم نشده است.")
        if not (api_token or "").strip():
            raise HTTPException(status_code=400, detail="توکن API تنظیم نشده است.")
        # Soft check only — some providers expose chat without a working /models route
        return

    if not check_ollama(ollama_url):
        raise HTTPException(
            status_code=503,
            detail=(
                f"سرور Ollama در دسترس نیست ({ollama_url}). "
                "لطفاً Ollama را اجرا کنید: 'ollama serve'"
            ),
        )


def assert_ollama(base_url: str = DEFAULT_OLLAMA_URL) -> None:
    """Backward-compatible alias."""
    assert_llm_ready(provider="ollama", ollama_url=base_url)


def get_llm(
    base_url: str = DEFAULT_OLLAMA_URL,
    model: str = DEFAULT_MODEL,
    temperature: float = 0.3,
    num_ctx: int = DEFAULT_NUM_CTX,
    provider: str = "ollama",
    api_token: str = "",
) -> Union[ChatOllama, OpenAICompatLLM]:
    """
    Get a cached LLM instance.
    provider=ollama -> ChatOllama (base_url = ollama URL)
    provider=api    -> OpenAI-compatible (base_url = API base, api_token required)
    """
    provider = _normalize_provider(provider)

    if provider == "api":
        assert_llm_ready(
            provider="api",
            api_base_url=base_url,
            api_token=api_token,
        )
        key = ("api", base_url, model, temperature, api_token)
        if key not in _cache:
            _cache[key] = OpenAICompatLLM(
                base_url=base_url,
                model=model,
                api_token=api_token,
                temperature=temperature,
            )
        return _cache[key]

    assert_ollama(base_url)
    key = ("ollama", base_url, model, temperature, num_ctx)
    if key not in _cache:
        _cache[key] = ChatOllama(
            base_url=base_url,
            model=model,
            temperature=temperature,
            num_ctx=num_ctx,
        )
    return _cache[key]


def get_llm_from_request(req: Any, temperature: Optional[float] = None) -> Union[ChatOllama, OpenAICompatLLM]:
    """Build LLM from a request object that may include provider/api fields."""
    provider = _normalize_provider(getattr(req, "provider", "ollama"))
    temp = temperature if temperature is not None else float(getattr(req, "temperature", 0.3) or 0.3)
    model = getattr(req, "model", None) or DEFAULT_MODEL

    if provider == "api":
        return get_llm(
            base_url=(getattr(req, "api_base_url", None) or DEFAULT_API_BASE_URL),
            model=model,
            temperature=temp,
            provider="api",
            api_token=getattr(req, "api_token", "") or "",
        )

    return get_llm(
        base_url=getattr(req, "ollama_url", None) or DEFAULT_OLLAMA_URL,
        model=model,
        temperature=temp,
        provider="ollama",
    )


def list_ollama_models(base_url: str = DEFAULT_OLLAMA_URL) -> list[str]:
    try:
        resp = requests.get(f"{base_url.rstrip('/')}/api/tags", timeout=5)
        resp.raise_for_status()
        return sorted(m["name"] for m in resp.json().get("models", []))
    except Exception:
        return []


def list_api_models(base_url: str = DEFAULT_API_BASE_URL, api_token: str = "") -> list[dict]:
    """
    Return [{"id": "...", "label": "..."}, ...] from the remote /models endpoint.
    Returns [] when unavailable — UI lets the user type a model id manually.
    """
    if not (base_url or "").strip():
        return []
    try:
        url = base_url.rstrip("/")
        if not url.endswith("/models"):
            url = f"{url}/models" if url.endswith("/v1") else f"{url}/v1/models"
        headers = {}
        if api_token:
            headers["Authorization"] = f"Bearer {api_token}"
        resp = requests.get(url, headers=headers, timeout=8)
        if resp.status_code >= 400:
            return []
        data = resp.json()
        items = data.get("data") if isinstance(data, dict) else data
        if not isinstance(items, list) or not items:
            return []
        remote = []
        for item in items:
            if isinstance(item, dict):
                mid = item.get("id") or item.get("name")
            else:
                mid = str(item)
            if not mid:
                continue
            remote.append({"id": mid, "label": mid})
        return remote
    except Exception:
        return []
