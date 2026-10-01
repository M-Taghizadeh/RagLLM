"""
SSE helpers.

Slow models can stay silent for minutes before the first token; proxies and
browsers drop idle connections, so emit SSE comment lines (ignored by the
frontend parser) while the wrapped generator is waiting.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import AsyncIterator

SSE_HEARTBEAT_SECONDS = 15.0

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
}


async def with_heartbeat(
    agen: AsyncIterator[str],
    interval: float = SSE_HEARTBEAT_SECONDS,
) -> AsyncIterator[str]:
    it = agen.__aiter__()
    pending: asyncio.Task | None = None
    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(it.__anext__())
            done, _ = await asyncio.wait({pending}, timeout=interval)
            if not done:
                yield ": ping\n\n"
                continue
            task, pending = pending, None
            try:
                item = task.result()
            except StopAsyncIteration:
                break
            yield item
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            with contextlib.suppress(BaseException):
                await pending
        aclose = getattr(agen, "aclose", None)
        if aclose is not None:
            with contextlib.suppress(BaseException):
                await aclose()
