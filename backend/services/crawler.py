"""
Crawler Service - fetch and extract text from URLs (web articles & RSS feeds)
"""

import re
from typing import List, Dict
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    )
}
TIMEOUT = 20


# ------------------------------------------------------------------ #
# Single article / web page                                           #
# ------------------------------------------------------------------ #

def fetch_article(url: str) -> Dict[str, str]:
    """
    Fetch a web page and return {url, title, text}.
    Raises on network / parse failure.
    """
    resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    resp.encoding = resp.apparent_encoding or "utf-8"

    soup = BeautifulSoup(resp.text, "html.parser")

    # Extract title
    title = ""
    if soup.title:
        title = soup.title.get_text(strip=True)

    # Remove noise tags
    for tag in soup(["script", "style", "nav", "footer", "header",
                     "aside", "form", "button", "noscript", "iframe"]):
        tag.decompose()

    # Prefer <article> or <main> when available
    body = soup.find("article") or soup.find("main") or soup.body or soup
    text = body.get_text(separator="\n", strip=True)

    # Collapse excessive blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)

    return {"url": url, "title": title, "text": text}


# ------------------------------------------------------------------ #
# RSS Feed                                                            #
# ------------------------------------------------------------------ #

def fetch_rss(feed_url: str, max_items: int = 20) -> List[Dict[str, str]]:
    """
    Parse an RSS/Atom feed and return list of
    {url, title, summary} for each entry.
    Falls back to raw XML parsing if feedparser is unavailable.
    """
    try:
        import feedparser  # optional dependency
        feed = feedparser.parse(feed_url)
        items = []
        for entry in feed.entries[:max_items]:
            items.append({
                "url":     entry.get("link", ""),
                "title":   entry.get("title", ""),
                "summary": BeautifulSoup(
                    entry.get("summary", entry.get("description", "")),
                    "html.parser"
                ).get_text(strip=True),
            })
        return items
    except ImportError:
        pass

    # Fallback: basic XML parsing with BeautifulSoup
    resp = requests.get(feed_url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.content, "xml")

    items = []
    for item in soup.find_all("item")[:max_items]:
        link    = item.find("link")
        title   = item.find("title")
        desc    = item.find("description")
        items.append({
            "url":     link.get_text(strip=True) if link else "",
            "title":   title.get_text(strip=True) if title else "",
            "summary": BeautifulSoup(
                desc.get_text(strip=True) if desc else "", "html.parser"
            ).get_text(strip=True),
        })
    return items


def is_rss_url(url: str) -> bool:
    """Heuristic: ends with /feed, /rss, .xml, or contains 'rss'/'feed' in path."""
    path = urlparse(url).path.lower()
    return any(kw in path for kw in ["/feed", "/rss", ".xml", "atom"])
