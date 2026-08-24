"""
Hybrid retrieval: dense (FAISS) + sparse (BM25) fused with Reciprocal Rank Fusion.
"""

from __future__ import annotations

from typing import List, Optional

from langchain_core.documents import Document
from langchain_community.retrievers import BM25Retriever
from langchain_community.vectorstores import FAISS


def reciprocal_rank_fusion(
    result_lists: List[List[Document]],
    weights: Optional[List[float]] = None,
    k: int = 60,
    top_n: int = 8,
) -> List[Document]:
    """Merge ranked lists with weighted RRF. Deduplicates by page_content + source."""
    weights = weights or [1.0] * len(result_lists)

    if len(weights) != len(result_lists):
        raise ValueError("weights must match number of result_lists")

    scores: dict[str, float] = {}
    docs_by_key: dict[str, Document] = {}

    for w, docs in zip(weights, result_lists):
        for rank, doc in enumerate(docs, start=1):
            key = (
                str(doc.metadata.get("source_file", ""))
                + "|"
                + str(doc.metadata.get("page", ""))
                + "|"
                + doc.page_content
            )
            scores[key] = scores.get(key, 0.0) + w / (k + rank)
            if key not in docs_by_key:
                docs_by_key[key] = doc

    ranked = sorted(scores.keys(), key=lambda x: scores[x], reverse=True)
    return [docs_by_key[key] for key in ranked[:top_n]]


class HybridRetriever:
    """FAISS similarity + BM25, fused via weighted RRF."""

    def __init__(
        self,
        vectorstore: FAISS,
        documents: List[Document],
        dense_k: int = 20,
        sparse_k: int = 20,
        final_k: int = 8,
        dense_weight: float = 0.7,
        sparse_weight: float = 0.3,
    ):
        self.vectorstore = vectorstore
        self.dense_k = dense_k
        self.sparse_k = sparse_k
        self.final_k = final_k
        self.dense_weight = dense_weight
        self.sparse_weight = sparse_weight
        self.bm25: Optional[BM25Retriever] = None
        if documents:
            self.bm25 = BM25Retriever.from_documents(documents)
            self.bm25.k = sparse_k

    def invoke(self, query: str, k: Optional[int] = None) -> List[Document]:
        """k overrides final_k for this call (needed for eval @ different cutoffs)."""
        top_n = k or self.final_k
        search_k = max(self.dense_k, top_n)

        dense_docs = self.vectorstore.similarity_search(query, k=search_k)

        if self.bm25 is None:
            return dense_docs[:top_n]

        prev_bm25_k = self.bm25.k
        self.bm25.k = max(self.sparse_k, top_n)
        sparse_docs = self.bm25.invoke(query)
        self.bm25.k = prev_bm25_k

        return reciprocal_rank_fusion(
            [dense_docs, sparse_docs],
            weights=[self.dense_weight, self.sparse_weight],
            top_n=top_n,
        )
