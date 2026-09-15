"""
BGE Reranker v2 M3 — Cross-encoder running on CUDA with float16.
Loaded on demand (Lazy).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import List, Tuple

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer
from langchain_core.documents import Document

_DEFAULT_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "models", "bge-reranker-v2-m3")
)
MODEL_PATH = os.environ.get("RERANKER_MODEL_PATH", _DEFAULT_PATH)
USE_RERANKER = os.environ.get("USE_RERANKER", "1").strip() not in ("0", "false", "False")
RERANK_CANDIDATES = int(os.environ.get("RERANK_CANDIDATES", "20"))
RERANK_MIN_SCORE = float(os.environ.get("RERANK_MIN_SCORE", "-100"))


class BGEReranker:
    """Local BGE-reranker-v2-m3 wrapper using native transformers."""

    _instance: BGEReranker | None = None

    def __init__(self, model_path: str = MODEL_PATH):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model_path = os.path.abspath(model_path)

        if not os.path.isdir(self.model_path):
            raise FileNotFoundError(f"مسیر ریرنکر یافت نشد: {self.model_path}")

        print(f"--> [RERANKER] Loading model to {self.device} (float16)...", flush=True)
        self.tokenizer = AutoTokenizer.from_pretrained(
            self.model_path,
            local_files_only=True,
        )
        self.model = AutoModelForSequenceClassification.from_pretrained(
            self.model_path,
            torch_dtype=torch.float16 if self.device == "cuda" else torch.float32,
            local_files_only=True,
        ).to(self.device)
        self.model.eval()
        print(f"--> [RERANKER] Ready on {self.device}!", flush=True)

    @classmethod
    def get_instance(cls, model_path: str = MODEL_PATH) -> BGEReranker:
        if cls._instance is None:
            cls._instance = cls(model_path)
        return cls._instance

    def score(self, query: str, docs: List[Document]) -> List[Tuple[Document, float]]:
        if not docs:
            return []

        pairs = [[query, d.page_content] for d in docs]

        try:
            with torch.inference_mode():
                inputs = self.tokenizer(
                    pairs,
                    padding=True,
                    truncation=True,
                    max_length=512,
                    return_tensors="pt",
                ).to(self.device)

                scores = self.model(**inputs, return_dict=True).logits.view(-1).float()
                scores_list = scores.cpu().tolist()
                if isinstance(scores_list, float):
                    scores_list = [scores_list]
        finally:
            if self.device == "cuda":
                torch.cuda.empty_cache()

        return list(zip(docs, [float(s) for s in scores_list]))

    def rerank(self, query: str, docs: List[Document], top_n: int = 8) -> List[Document]:
        scored = self.score(query, docs)
        scored.sort(key=lambda x: x[1], reverse=True)
        scored = [(d, s) for d, s in scored if s >= RERANK_MIN_SCORE]
        return [d for d, _ in scored[:top_n]]


def get_reranker_safe() -> BGEReranker | None:
    if not USE_RERANKER:
        return None
    try:
        return BGEReranker.get_instance()
    except Exception as ex:
        print(f"--> [RERANKER ERROR] Disabled: {ex}", flush=True)
        return None