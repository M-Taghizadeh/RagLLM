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
    k: int = 60,
    top_n: int = 8,
) -> List[Document]:
    """Merge ranked lists with RRF. Deduplicates by page_content + source."""
    scores: dict[str, float] = {}
    docs_by_key: dict[str, Document] = {}

    for docs in result_lists:
        for rank, doc in enumerate(docs, start=1):
            key = (
                doc.page_content[:200]
                + "|"
                + str(doc.metadata.get("source_file", ""))
                + "|"
                + str(doc.metadata.get("page", ""))
            )
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank)
            if key not in docs_by_key:
                docs_by_key[key] = doc

    ranked = sorted(scores.keys(), key=lambda x: scores[x], reverse=True)
    return [docs_by_key[key] for key in ranked[:top_n]]


class HybridRetriever:
    """FAISS similarity + BM25, fused via RRF."""

    def __init__(
        self,
        vectorstore: FAISS,
        documents: List[Document],
        dense_k: int = 20,
        sparse_k: int = 20,
        final_k: int = 8,
    ):
        self.vectorstore = vectorstore
        self.dense_k = dense_k
        self.sparse_k = sparse_k
        self.final_k = final_k
        self.bm25: Optional[BM25Retriever] = None
        if documents:
            self.bm25 = BM25Retriever.from_documents(documents)
            self.bm25.k = sparse_k

    def invoke(self, query: str) -> List[Document]:
        dense_docs = self.vectorstore.similarity_search(query, k=self.dense_k)
        if self.bm25 is None:
            return dense_docs[: self.final_k]
        sparse_docs = self.bm25.invoke(query)
        return reciprocal_rank_fusion(
            [dense_docs, sparse_docs],
            top_n=self.final_k,
        )
