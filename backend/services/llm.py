"""
LLM Service - Ollama + OpenAI-compatible API providers.
"""

import json
import os
import time
import asyncio
import threading

import httpx
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
# NOTE: renamed from DEFAULT_TOP_K -> RAG_TOP_K. "top_k" is also a common
# Ollama/LLM *sampling* parameter name; if your .env has DEFAULT_TOP_K=50
# left over from an Ollama template, it was accidentally being consumed
# here as "how many chunks to stuff into the RAG context" — not as an LLM
# sampling setting. 50 chunks per answer is too much noise for the model.
# Set RAG_TOP_K explicitly (6-10 is a good default with a reranker).
DEFAULT_TOP_K      = int(os.environ.get("RAG_TOP_K", "8"))
DENSE_WEIGHT       = float(os.environ.get("DENSE_WEIGHT", "0.7"))
SPARSE_WEIGHT      = float(os.environ.get("SPARSE_WEIGHT", "0.3"))
DEFAULT_NUM_CTX    = int(os.environ.get("NUM_CTX", "8192"))
DEFAULT_TEMPERATURE = float(os.environ.get("DEFAULT_TEMPERATURE", "0.3"))

# Slow models on server hardware may think for minutes before the first token.
# Read timeout = max silence allowed between two chunks from the model server.
LLM_CONNECT_TIMEOUT = 15.0
LLM_READ_TIMEOUT    = 1800.0

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


def _msg_content(msg: Any) -> Any:
    """Preserve multimodal content blocks (list) for vision models."""
    if hasattr(msg, "content"):
        c = msg.content
        if isinstance(c, (str, list)):
            return c
        return str(c)
    return str(msg)


def _to_openai_messages(messages: Iterable[Any]) -> List[dict]:
    out: List[dict] = []
    for m in messages:
        content = _msg_content(m)
        if isinstance(content, list):
            normalized = []
            for block in content:
                if not isinstance(block, dict):
                    normalized.append(block)
                    continue
                if block.get("type") == "image_url":
                    raw = block.get("image_url")
                    if isinstance(raw, str):
                        normalized.append({"type": "image_url", "image_url": {"url": raw}})
                    else:
                        normalized.append(block)
                else:
                    normalized.append(block)
            content = normalized
        out.append({"role": _msg_role(m), "content": content})
    return out


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
        timeout: float | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_token = api_token or ""
        self.temperature = temperature
        self.timeout = timeout if timeout is not None else LLM_READ_TIMEOUT

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
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        sentinel = object()
        stop = threading.Event()

        def _emit(item):
            if stop.is_set():
                return
            try:
                loop.call_soon_threadsafe(queue.put_nowait, item)
            except RuntimeError:
                stop.set()

        # Dedicated thread (not the shared default executor): a multi-minute generation
        # must never starve to_thread() calls used by every other request.
        def _run():
            try:
                with requests.post(
                    self._chat_url(),
                    headers=self._headers(),
                    json=self._payload(messages, stream=True),
                    stream=True,
                    timeout=(LLM_CONNECT_TIMEOUT, self.timeout),
                ) as resp:
                    if resp.status_code >= 400:
                        try:
                            detail = resp.json()
                        except Exception:
                            detail = resp.text
                        raise RuntimeError(f"API error {resp.status_code}: {detail}")
                    for raw in resp.iter_lines(decode_unicode=True):
                        if stop.is_set():
                            return
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
                            _emit(token)
            except Exception as e:
                _emit(e)
            finally:
                _emit(sentinel)

        threading.Thread(target=_run, name="llm-api-stream", daemon=True).start()

        try:
            while True:
                item = await queue.get()
                if item is sentinel:
                    break
                if isinstance(item, Exception):
                    raise item
                yield _SimpleChunk(item)
        finally:
            stop.set()

    async def ainvoke(self, messages: Iterable[Any]) -> _SimpleChunk:
        def _call():
            resp = requests.post(
                self._chat_url(),
                headers=self._headers(),
                json=self._payload(messages, stream=False),
                timeout=(LLM_CONNECT_TIMEOUT, self.timeout),
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

_OLLAMA_OK_TTL = 30.0
_ollama_last_ok: dict[str, float] = {}


def check_ollama(base_url: str = DEFAULT_OLLAMA_URL) -> bool:
    """
    Ollama can stall for a few seconds (model loading into VRAM, self-update restart),
    so retry with a longer timeout instead of failing the chat on the first hiccup.
    """
    url = base_url.rstrip("/")
    if time.monotonic() - _ollama_last_ok.get(url, 0.0) < _OLLAMA_OK_TTL:
        return True
    for attempt in range(3):
        try:
            resp = requests.get(f"{url}/api/tags", timeout=8)
            if resp.status_code == 200:
                _ollama_last_ok[url] = time.monotonic()
                return True
        except Exception:
            pass
        if attempt < 2:
            time.sleep(1.5)
    _ollama_last_ok.pop(url, None)
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
            client_kwargs={"timeout": httpx.Timeout(LLM_READ_TIMEOUT, connect=LLM_CONNECT_TIMEOUT)},
        )
    return _cache[key]


def get_llm_from_request(req: Any, temperature: Optional[float] = None) -> Union[ChatOllama, OpenAICompatLLM]:
    """Build LLM from a request object that may include provider/api fields."""
    provider = _normalize_provider(getattr(req, "provider", "ollama"))
    if temperature is not None:
        temp = temperature
    else:
        req_temp = getattr(req, "temperature", None)
        temp = float(req_temp) if req_temp is not None else DEFAULT_TEMPERATURE
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
