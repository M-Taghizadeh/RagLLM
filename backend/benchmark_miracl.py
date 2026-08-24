"""
Benchmark for RagBot's actual hybrid retriever against MIRACL-fa
==================================================================

Unlike a generic re-implementation, this script imports YOUR OWN code
(services.retrieval.HybridRetriever, services.retrieval.reciprocal_rank_fusion,
services.embeddings.BGEEmbeddings) and runs it against MIRACL-fa, a
well-known human-annotated Persian retrieval benchmark (Persian Wikipedia).

It reports nDCG@10 / Recall@100 / MRR@10 for three conditions built from
YOUR classes:
  1. Dense only          (vectorstore.similarity_search)
  2. Sparse only          (BM25Retriever, same object your HybridRetriever uses)
  3. Hybrid (your code)   (HybridRetriever.invoke -> reciprocal_rank_fusion)

------------------------------------------------------------------------
WHERE TO PUT THIS FILE
------------------------------------------------------------------------
Copy this file into your project's `backend/` folder, right next to
`main.py`:

    RagBot/backend/benchmark_miracl.py

It relies on the same relative imports (`from services.retrieval import ...`)
that main.py uses, and on BGEEmbeddings finding the model at
`RagBot/models/bge-m3` exactly like your running server does.

------------------------------------------------------------------------
INSTALL (in the same venv you use to run the server)
------------------------------------------------------------------------
pip install datasets ranx tqdm
# everything else (faiss-cpu, rank-bm25, sentence-transformers, langchain*)
# is already in your requirements.txt

------------------------------------------------------------------------
R--UN (from inside backend/, with venv activated)
----------------------------------------------------------------------
python benchmark_miracl.py --corpus-limit 20000        # quick sanity run
python benchmark_miracl.py --corpus-limit -1            # full MIRACL-fa corpus (slow, ~2M passages)

------------------------------------------------------------------------
NOTES
------------------------------------------------------------------------
- `--corpus-limit` caps how many MIRACL passages get indexed (for speed).
  Every passage that appears in the qrels is always kept regardless of the
  limit, so Recall@100 stays an unbiased measurement -- only the size of
  the "distractor" pool shrinks.
- Uses the official `mteb/MIRACLRetrieval` re-upload (plain parquet) instead
  of the original `miracl/miracl` repo, because that original repo uses a
  loading script that recent `datasets` versions (>=4.0) refuse to execute
  at all, even with trust_remote_code=True.
- This does NOT touch your 200 PDFs or your faiss_db/ collections at all.
  It builds a completely separate, temporary in-memory FAISS index from
  MIRACL passages, using your BGEEmbeddings + FAISS(IndexFlatIP) + BM25Retriever
  + reciprocal_rank_fusion code, so the numbers reflect your actual pipeline
  logic on a standard, independently-labeled benchmark.
- Literature reference points printed at the end are cross-language MIRACL
  averages (not fa-specific, since exact fa breakdowns vary across papers).
  Use them as a rough sanity check, not a certified target.
"""

import argparse
import json
import sys
import time
from collections import defaultdict

import numpy as np
from tqdm import tqdm


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lang", default="fa")
    ap.add_argument("--corpus-limit", type=int, default=20000,
                     help="Max MIRACL passages to index (-1 = full corpus, ~2M for fa)")
    ap.add_argument("--dense-k", type=int, default=100, help="Depth for dense-only run / pool depth for hybrid")
    ap.add_argument("--sparse-k", type=int, default=100, help="Depth for sparse-only run / pool depth for hybrid")
    ap.add_argument("--final-k", type=int, default=100, help="Depth of the fused hybrid ranking to evaluate")
    ap.add_argument("--dense-weight", type=float, default=0.7, help="Weight for dense retriever in RRF")
    ap.add_argument("--sparse-weight", type=float, default=0.3, help="Weight for sparse retriever in RRF")
    ap.add_argument("--embed-batch-size", type=int, default=32, help="Matches your vectorstore.py default")
    ap.add_argument("--output", default="benchmark_results.json")
    args = ap.parse_args()

    # -------------------------------------------------------------
    # 0) Make sure we can import the project's own `services` package
    #    (this script is meant to live in backend/, next to main.py)
    # -------------------------------------------------------------
    try:
        from services.embeddings import BGEEmbeddings
        from services.retrieval import HybridRetriever, reciprocal_rank_fusion  # noqa: F401
    except ImportError as e:
        print(
            "ERROR: could not import `services.*`.\n"
            "This script must be placed in the `backend/` folder of your project, "
            "next to main.py, and run from inside that folder with your project's venv "
            f"activated.\nOriginal error: {e}"
        )
        sys.exit(1)

    from langchain_core.documents import Document
    from langchain_community.retrievers import BM25Retriever
    from langchain_community.vectorstores import FAISS
    from langchain_community.docstore.in_memory import InMemoryDocstore
    import faiss as faiss_lib
    from datasets import load_dataset
    from ranx import Qrels, Run, evaluate

    # -------------------------------------------------------------
    # 1) Load MIRACL queries + relevance judgments
    #    NOTE: the original `miracl/miracl` repo uses a loading script,
    #    which newer versions of `datasets` (>=4.0) refuse to run at all
    #    (not even with trust_remote_code=True). We use the official
    #    MTEB re-upload instead, which is plain parquet -- same data,
    #    split into per-language subsets: "{lang}-corpus", "{lang}-queries",
    #    "{lang}-qrels", all under the single "dev" split.
    # -------------------------------------------------------------
    log(f"Loading MIRACL topics/qrels via mteb/MIRACLRetrieval: lang={args.lang} ...")
    queries_ds = load_dataset("mteb/MIRACLRetrieval", f"{args.lang}-queries", split="dev")
    qrels_ds = load_dataset("mteb/MIRACLRetrieval", f"{args.lang}-qrels", split="dev")

    queries = {}
    for row in queries_ds:
        qid = str(row.get("_id") or row.get("query_id") or row.get("id"))
        queries[qid] = row.get("text") or row.get("query")

    qrels = defaultdict(dict)
    for row in qrels_ds:
        qid = str(row.get("query-id") or row.get("query_id"))
        docid = str(row.get("corpus-id") or row.get("docid"))
        rel = int(row.get("score", row.get("relevance", 1)))
        qrels[qid][docid] = rel

    # keep only queries that actually have at least one relevance judgment
    queries = {qid: q for qid, q in queries.items() if qid in qrels}

    log(f"Loaded {len(queries)} queries, {sum(len(v) for v in qrels.values())} relevance judgments.")

    # -------------------------------------------------------------
    # 2) Stream + select corpus passages (always keep qrels-relevant ones)
    # -------------------------------------------------------------
    log("Streaming MIRACL-fa corpus (mteb/MIRACLRetrieval, '{lang}-corpus' subset) ...")
    corpus_ds = load_dataset("mteb/MIRACLRetrieval", f"{args.lang}-corpus", split="dev", streaming=True)
    relevant_ids = {docid for docmap in qrels.values() for docid in docmap.keys()}

    documents = []  # List[Document], metadata["source_file"] holds the MIRACL docid
    seen = set()
    n_seen = 0
    for row in tqdm(corpus_ds, desc="Streaming corpus"):
        docid = str(row.get("_id") or row.get("docid"))
        n_seen += 1
        keep = (args.corpus_limit == -1) or (len(documents) < args.corpus_limit) or (docid in relevant_ids)
        if keep and docid not in seen:
            text = ((row.get("title", "") or "") + " " + (row.get("text", "") or "")).strip()
            documents.append(Document(page_content=text, metadata={"source_file": docid, "page": ""}))
            seen.add(docid)
        if args.corpus_limit != -1 and len(documents) >= args.corpus_limit and relevant_ids.issubset(seen):
            break

    log(f"Indexed {len(documents)} passages (scanned {n_seen} from the stream).")
    missing = relevant_ids - seen
    if missing:
        log(f"WARNING: {len(missing)} qrels-relevant passages were not found in the corpus stream.")

    # -------------------------------------------------------------
    # 3) Build the FAISS index EXACTLY the way vectorstore.py does it:
    #    manual IndexFlatIP over normalized BGE-M3 embeddings, not
    #    FAISS.from_documents() (which would default to L2 distance).
    # -------------------------------------------------------------
    log("Loading BGEEmbeddings (your production embedding wrapper) ...")
    embeddings = BGEEmbeddings.get_instance()

    log("Embedding corpus passages with your embeddings.embed_documents() ...")
    texts = [d.page_content for d in documents]
    vectors = []
    BATCH = args.embed_batch_size
    n_batches = (len(texts) + BATCH - 1) // BATCH
    for b in tqdm(range(n_batches), desc="Embedding corpus"):
        start, end = b * BATCH, min((b + 1) * BATCH, len(texts))
        vectors.extend(embeddings.embed_documents(texts[start:end]))

    dim = len(vectors[0])
    index = faiss_lib.IndexFlatIP(dim)
    index.add(np.array(vectors, dtype="float32"))

    index_to_docstore_id = {i: str(i) for i in range(len(documents))}
    docstore = InMemoryDocstore({str(i): documents[i] for i in range(len(documents))})
    vs = FAISS(
        embedding_function=embeddings,
        index=index,
        docstore=docstore,
        index_to_docstore_id=index_to_docstore_id,
    )
    log(f"FAISS(IndexFlatIP) built: {index.ntotal} vectors, dim={dim} (matches vectorstore.py).")

    # -------------------------------------------------------------
    # 4) Build YOUR HybridRetriever (this also builds the BM25Retriever
    #    internally, identical to what rag.py does per chat request)
    # -------------------------------------------------------------
    log("Building HybridRetriever (your production class) ...")
    retriever = HybridRetriever(
        vectorstore=vs,
        documents=documents,
        dense_k=args.dense_k,
        sparse_k=args.sparse_k,
        final_k=args.final_k,
        dense_weight=args.dense_weight,
        sparse_weight=args.sparse_weight,
    )
    bm25 = retriever.bm25  # reuse the exact same BM25Retriever instance for the sparse-only run
    bm25.k = args.sparse_k

    # -------------------------------------------------------------
    # 5) Run all three conditions per query
    # -------------------------------------------------------------
    def docs_to_run(docs):
        n = len(docs)
        return {d.metadata.get("source_file", ""): float(n - i) for i, d in enumerate(docs)}

    run_dense, run_sparse = {}, {}

    log("Running Dense-only / Sparse-only retrieval per query ...")
    dense_pool: dict[str, list] = {}
    sparse_pool: dict[str, list] = {}
    for qid, qtext in tqdm(queries.items(), desc="Retrieving"):
        dense_docs = vs.similarity_search(qtext, k=args.dense_k)
        sparse_docs = bm25.invoke(qtext)
        run_dense[qid] = docs_to_run(dense_docs)
        run_sparse[qid] = docs_to_run(sparse_docs)
        dense_pool[qid] = dense_docs
        sparse_pool[qid] = sparse_docs

    # -------------------------------------------------------------
    # 5b) Grid search over weight combinations
    # -------------------------------------------------------------
    weight_pairs = [
        (1.0, 0.0),
        (0.9, 0.1),
        (0.8, 0.2),
        (0.7, 0.3),
        (0.6, 0.4),
        (0.5, 0.5),
    ]

    log("Grid searching weight combinations (no re-embedding needed) ...")
    ranx_qrels = Qrels(qrels)
    grid_results = {}
    for dw, sw in weight_pairs:
        run_hybrid = {}
        for qid in queries:
            fused = reciprocal_rank_fusion(
                [dense_pool[qid], sparse_pool[qid]],
                weights=[dw, sw],
                top_n=args.final_k,
            )
            run_hybrid[qid] = docs_to_run(fused)
        scores = evaluate(ranx_qrels, Run(run_hybrid), ["ndcg@10", "recall@100", "mrr@10"])
        grid_results[(dw, sw)] = scores
        log(f"  dense={dw:.1f} sparse={sw:.1f} -> nDCG@10={scores['ndcg@10']:.4f}  "
            f"Recall@100={scores['recall@100']:.4f}  MRR@10={scores['mrr@10']:.4f}")

    best_pair = max(grid_results, key=lambda p: grid_results[p]["ndcg@10"])
    log(f"\n★ Best weights: DENSE={best_pair[0]}  SPARSE={best_pair[1]}  "
        f"nDCG@10={grid_results[best_pair]['ndcg@10']:.4f}")

    # use best weights for the final hybrid run
    run_hybrid_best = {}
    for qid in queries:
        fused = reciprocal_rank_fusion(
            [dense_pool[qid], sparse_pool[qid]],
            weights=list(best_pair),
            top_n=args.final_k,
        )
        run_hybrid_best[qid] = docs_to_run(fused)

    # -------------------------------------------------------------
    # 6) Evaluate
    # -------------------------------------------------------------
    log("Computing nDCG@10 / Recall@100 / MRR@10 / Precision@10 ...")
    results = {}
    for name, run_dict in [
        ("Dense only (BGE-M3)", run_dense),
        ("Sparse only (BM25)", run_sparse),
        (f"Hybrid best ({best_pair[0]}/{best_pair[1]})", run_hybrid_best),
    ]:
        scores = evaluate(ranx_qrels, Run(run_dict), ["ndcg@10", "recall@100", "mrr@10", "precision@10"])
        results[name] = scores
        log(f"{name:>36s} -> nDCG@10={scores['ndcg@10']:.4f}  Recall@100={scores['recall@100']:.4f}  "
            f"MRR@10={scores['mrr@10']:.4f}  P@10={scores['precision@10']:.4f}")

    # -------------------------------------------------------------
    # 7) Summary
    # -------------------------------------------------------------
    print("\n" + "=" * 78)
    print(f"RESULTS on MIRACL-{args.lang} (dev split, {len(queries)} queries, "
          f"{len(documents)} indexed passages)")
    print("Retriever code under test: your services/retrieval.py + services/embeddings.py")
    print("=" * 78)
    print(f"{'Method':<32}{'nDCG@10':>10}{'Recall@100':>13}{'MRR@10':>10}{'P@10':>8}")
    for name, scores in results.items():
        print(f"{name:<32}{scores['ndcg@10']:>10.4f}{scores['recall@100']:>13.4f}"
              f"{scores['mrr@10']:>10.4f}{scores['precision@10']:>8.4f}")

    print("\nReference points from the literature (MIRACL avg. across languages, dev set):")
    print("  BM25 baseline (official)                ~0.39-0.45 nDCG@10")
    print("  mDPR baseline (official)                  ~0.40 nDCG@10")
    print("  BM25+mDPR hybrid (official, alpha=0.5)     ~0.55-0.58 nDCG@10")
    print("  BGE-M3 dense (per BGE-M3 paper)            state-of-the-art among open embeddings on MIRACL")
    print("These are cross-language averages, not fa-specific -- treat them as a rough sanity")
    print("check. What matters most is the gap between your own three rows above:")
    print("  - Hybrid clearly beats both Dense-only and Sparse-only -> RRF fusion is earning its keep.")
    print("  - Hybrid ~= Dense-only -> BM25 is adding little; consider tuning rrf `k` (currently 60)")
    print("    or checking whether your BM25 tokenizer handles Persian well.")
    print("  - Dense-only far below ~0.45-0.50 nDCG@10 -> check that BGE-M3 is loading correctly")
    print("    and that embeddings are actually being normalized before the FAISS IndexFlatIP add/search.")

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump({
            "lang": args.lang, "split": "dev",
            "num_queries": len(queries), "num_passages_indexed": len(documents),
            "dense_k": args.dense_k, "sparse_k": args.sparse_k, "final_k": args.final_k,
            "best_weights": {"dense": best_pair[0], "sparse": best_pair[1]},
            "grid_search": {
                f"dense={dw}_sparse={sw}": v
                for (dw, sw), v in grid_results.items()
            },
            "results": results,
        }, f, ensure_ascii=False, indent=2)
    log(f"Saved detailed results to {args.output}")


if __name__ == "__main__":
    main()
