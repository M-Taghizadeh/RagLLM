"""
BGE-M3 Embedding Service — Local HuggingFace/Transformers implementation.
"""

from __future__ import annotations

import os

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

from typing import List
import torch
from transformers import AutoModel, AutoTokenizer
from langchain_core.embeddings import Embeddings

DEFAULT_MODEL_PATH = os.environ.get("EMBEDDING_MODEL_PATH", "/app/models/bge-m3")


class BGEEmbeddings(Embeddings):
    """Local BGE-M3 wrapper."""

    _instance: BGEEmbeddings | None = None

    def __init__(self, model_path: str = DEFAULT_MODEL_PATH):
        print(f"--> [EMBEDDINGS] Initializing from path: {model_path}", flush=True)
        self.device = "cpu"
        self.model_path = model_path

        self.tokenizer = AutoTokenizer.from_pretrained(
            self.model_path,
            local_files_only=True,
        )
        self.model = AutoModel.from_pretrained(
            self.model_path,
            torch_dtype=torch.float32,
            local_files_only=True,
        ).to(self.device)
        self.model.eval()
        print(f"--> [EMBEDDINGS] Model loaded successfully on {self.device}!", flush=True)

    @classmethod
    def get_instance(cls, model_path: str = DEFAULT_MODEL_PATH) -> BGEEmbeddings:
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

        return embeddings.cpu().tolist()

    def embed_query(self, text: str) -> List[float]:
        return self.embed_documents([text])[0]