"""
Web Search Service - DuckDuckGo (ddgs package)
Falls back gracefully on timeout / rate-limit.
"""

from typing import List, Dict


def search(query: str, num_results: int = 8, timeout: int = 15) -> List[Dict[str, str]]:
    """
    Search DuckDuckGo and return list of {title, body, link}.
    Returns empty list on any failure (timeout, rate-limit, etc.)
    """
    results = []
    try:
        from ddgs import DDGS          # new package name (replaces duckduckgo-search)
        with DDGS(timeout=timeout) as ddgs:
            for r in ddgs.text(
                query,
                region="wt-wt",
                safesearch="off",
                max_results=num_results,
            ):
                results.append({
                    "title": r.get("title", ""),
                    "body":  r.get("body", ""),
                    "link":  r.get("href", ""),
                })
    except ImportError:
        # fallback: try old package name
        try:
            from duckduckgo_search import DDGS as OldDDGS
            with OldDDGS() as ddgs:
                for r in ddgs.text(query, region="wt-wt", safesearch="off", max_results=num_results):
                    results.append({
                        "title": r.get("title", ""),
                        "body":  r.get("body", ""),
                        "link":  r.get("href", ""),
                    })
        except Exception as e:
            print(f"[web_search] fallback error: {e}")
    except Exception as e:
        print(f"[web_search] DuckDuckGo error: {e}")

    return results


def search_text_only(query: str, num_results: int = 8) -> str:
    """Return concatenated body text from search results."""
    results = search(query, num_results)
    if not results:
        return ""
    return "\n".join(r["body"] for r in results if r["body"])
