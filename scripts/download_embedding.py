"""
Download BAAI/bge-m3 embedding model into models/bge-m3.

Usage (from repo root):
  python scripts/download_embedding.py
"""

from __future__ import annotations

import os
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TARGET_DIR = os.path.join(REPO_ROOT, "models", "bge-m3")
REPO_ID = "BAAI/bge-m3"


def main() -> int:
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("huggingface-hub نصب نیست. اجرا کنید:")
        print("  pip install huggingface-hub")
        return 1

    os.makedirs(TARGET_DIR, exist_ok=True)
    print(f"در حال دانلود {REPO_ID} به:\n  {TARGET_DIR}\n")
    snapshot_download(
        repo_id=REPO_ID,
        local_dir=TARGET_DIR,
        local_dir_use_symlinks=False,
    )
    print("\nدانلود کامل شد. مدل آماده استفاده است.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
