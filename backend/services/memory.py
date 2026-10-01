"""
Runtime memory introspection (Linux / Docker).

Respects the container memory limit (cgroup v2 / v1) when one is set, otherwise
the host total, so limits adapt to whatever server the stack runs on.
"""

from __future__ import annotations

import os
from typing import Optional

_UNLIMITED = 1 << 60


def _read_int(path: str) -> Optional[int]:
    try:
        with open(path, "r", encoding="ascii") as f:
            raw = f.read().strip()
    except OSError:
        return None
    if not raw or raw == "max":
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _meminfo() -> dict[str, int]:
    out: dict[str, int] = {}
    try:
        with open("/proc/meminfo", "r", encoding="ascii") as f:
            for line in f:
                name, _, rest = line.partition(":")
                parts = rest.split()
                if parts:
                    out[name] = int(parts[0]) * 1024
    except OSError:
        pass
    return out


def _cgroup_limit_and_usage() -> tuple[Optional[int], Optional[int]]:
    limit = _read_int("/sys/fs/cgroup/memory.max")
    if limit is not None:
        return limit, _read_int("/sys/fs/cgroup/memory.current")
    limit = _read_int("/sys/fs/cgroup/memory/memory.limit_in_bytes")
    if limit is not None and limit < _UNLIMITED:
        return limit, _read_int("/sys/fs/cgroup/memory/memory.usage_in_bytes")
    return None, None


def total_bytes() -> int:
    host_total = _meminfo().get("MemTotal") or 0
    limit, _ = _cgroup_limit_and_usage()
    if limit and (not host_total or limit < host_total):
        return limit
    return host_total or 8 * 1024 ** 3


def available_bytes() -> int:
    """Memory that can still be allocated without risking the OOM killer."""
    info = _meminfo()
    avail = info.get("MemAvailable")
    if avail is None:
        avail = info.get("MemFree", 0) + info.get("Cached", 0)
    limit, usage = _cgroup_limit_and_usage()
    if limit and usage is not None:
        avail = min(avail, max(0, limit - usage))
    return avail


def reserve_bytes() -> int:
    """Headroom always left free for model inference, uploads and other services."""
    return max(int(total_bytes() * 0.15), 768 * 1024 ** 2)


def cache_budget_bytes() -> int:
    """Upper bound for in-memory caches (knowledge-base indexes)."""
    return int(total_bytes() * 0.25)


def cpu_count() -> int:
    try:
        return len(os.sched_getaffinity(0)) or 1
    except (AttributeError, OSError):
        return os.cpu_count() or 1
