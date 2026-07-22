"""
BGE-M3 Embedding Service — multilingual SOTA dense embeddings.

Model: BAAI/bge-m3 (local folder: models/bge-m3)
Supports 100+ languages including Persian. No query/passage prefixes required.
"""

import os
from typing import List

import torch
from sentence_transformers import SentenceTransformer
from langchain_core.embeddings import Embeddings

DEFAULT_MODEL_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "models", "bge-m3"
)


class BGEEmbeddings(Embeddings):
    """Local BGE-M3 wrapper for LangChain. Uses CUDA when available."""

    _instance: "BGEEmbeddings | None" = None

    def __init__(self, model_path: str = DEFAULT_MODEL_PATH):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model_path = os.path.abspath(model_path)
        if not os.path.isdir(self.model_path):
            raise FileNotFoundError(
                f"مدل embedding پیدا نشد: {self.model_path}\n"
                "طبق README مدل BGE-M3 را در models/bge-m3 دانلود کنید."
            )
        self.model = SentenceTransformer(self.model_path, device=self.device)

    @classmethod
    def get_instance(cls, model_path: str = DEFAULT_MODEL_PATH) -> "BGEEmbeddings":
        if cls._instance is None:
            cls._instance = cls(model_path)
        return cls._instance

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        embeddings = self.model.encode(
            texts,
            convert_to_tensor=True,
            normalize_embeddings=True,
            show_progress_bar=False,
            batch_size=32,
        )
        return [e.tolist() for e in embeddings]

    def embed_query(self, text: str) -> List[float]:
        embedding = self.model.encode(
            text,
            convert_to_tensor=True,
            normalize_embeddings=True,
        )
        return embedding.tolist()
