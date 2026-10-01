"""
BGE-M3 Embedding Service — Local HuggingFace/Transformers implementation.
"""

from __future__ import annotations

import os

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

import threading
from typing import List
import torch
from transformers import AutoModel, AutoTokenizer
from langchain_core.embeddings import Embeddings

DEFAULT_MODEL_PATH = os.environ.get("EMBEDDING_MODEL_PATH", "/app/models/bge-m3")
# cpu (default) | cuda — loading BGE-M3 onto CUDA hangs in this Docker/WSL setup
EMBEDDING_DEVICE = os.environ.get("EMBEDDING_DEVICE", "cpu").strip().lower()


def _resolve_device() -> str:
    if EMBEDDING_DEVICE == "cuda" and torch.cuda.is_available():
        return "cuda"
    return "cpu"


class BGEEmbeddings(Embeddings):
    """Local BGE-M3 wrapper."""

    _instance: BGEEmbeddings | None = None
    _lock = threading.Lock()
    _infer_lock = threading.Lock()

    def __init__(self, model_path: str = DEFAULT_MODEL_PATH):
        print(f"--> [EMBEDDINGS] Initializing from path: {model_path}", flush=True)
        self.device = _resolve_device()
        self.model_path = model_path

        self.tokenizer = AutoTokenizer.from_pretrained(
            self.model_path,
            local_files_only=True,
        )
        self.model = AutoModel.from_pretrained(
            self.model_path,
            torch_dtype=torch.float16 if self.device == "cuda" else torch.float32,
            local_files_only=True,
        ).to(self.device)
        self.model.eval()
        print(f"--> [EMBEDDINGS] Model loaded successfully on {self.device}!", flush=True)

    @classmethod
    def get_instance(cls, model_path: str = DEFAULT_MODEL_PATH) -> BGEEmbeddings:
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls(model_path)
        return cls._instance

    def _mean_pooling(self, model_output, attention_mask):
        token_embeddings = model_output[0]
        input_mask_expanded = attention_mask.unsqueeze(-1).expand(token_embeddings.size()).float()
        return torch.sum(token_embeddings * input_mask_expanded, 1) / torch.clamp(input_mask_expanded.sum(1), min=1e-9)

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        # HF fast tokenizers are not thread-safe ("Already borrowed"); serialize inference.
        with self._infer_lock:
            encoded = self.tokenizer(
                texts,
                padding=True,
                truncation=True,
                max_length=512,
                return_tensors="pt",
            ).to(self.device)

            with torch.no_grad():
                output = self.model(**encoded)
                embeddings = self._mean_pooling(output, encoded["attention_mask"])
                embeddings = torch.nn.functional.normalize(embeddings, p=2, dim=1)

            return embeddings.float().cpu().tolist()

    def embed_query(self, text: str) -> List[float]:
        return self.embed_documents([text])[0]
