"""
Router: /api/alerts
News alert rules management + scanning URLs/RSS feeds against defined rules.
"""

import json
import sqlite3
import os
import asyncio
from typing import List, Optional, AsyncGenerator
from langchain_core.messages import HumanMessage

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from services.crawler import fetch_article, fetch_rss, is_rss_url
from services.llm import get_llm, check_ollama, DEFAULT_MODEL, DEFAULT_OLLAMA_URL

router = APIRouter()

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "ragbot.db")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ------------------------------------------------------------------ #
# Schemas                                                              #
# ------------------------------------------------------------------ #

class AlertRule(BaseModel):
    name:        str
    category:    str
    keywords:    str
    description: Optional[str] = ""


class ScanRequest(BaseModel):
    url:           str
    rule_ids:      Optional[List[int]] = None
    model:         str = DEFAULT_MODEL
    ollama_url:    str = DEFAULT_OLLAMA_URL
    max_rss_items: int = 20


# ------------------------------------------------------------------ #
# CRUD Endpoints                                                       #
# ------------------------------------------------------------------ #

@router.get("/rules")
def list_rules():
    conn = get_db()
    rows = conn.execute("SELECT * FROM alert_rules ORDER BY created_at DESC").fetchall()
    conn.close()
    return {"rules": [dict(r) for r in rows]}


@router.post("/rules")
def create_rule(rule: AlertRule):
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO alert_rules (name, category, keywords, description) VALUES (?,?,?,?)",
        (rule.name, rule.category, rule.keywords, rule.description),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return {"status": "created", "id": new_id}


@router.put("/rules/{rule_id}")
def update_rule(rule_id: int, rule: AlertRule):
    conn = get_db()
    conn.execute(
        "UPDATE alert_rules SET name=?, category=?, keywords=?, description=? WHERE id=?",
        (rule.name, rule.category, rule.keywords, rule.description, rule_id),
    )
    conn.commit()
    conn.close()
    return {"status": "updated"}


@router.delete("/rules/{rule_id}")
def delete_rule(rule_id: int):
    conn = get_db()
    conn.execute("DELETE FROM alert_rules WHERE id=?", (rule_id,))
    conn.commit()
    conn.close()
    return {"status": "deleted"}


# ------------------------------------------------------------------ #
# Alert Results                                                        #
# ------------------------------------------------------------------ #

@router.get("/results")
def list_results(rule_id: Optional[int] = None):
    conn = get_db()
    if rule_id:
        rows = conn.execute(
            "SELECT r.*, a.name as rule_name, a.category FROM alert_results r "
            "JOIN alert_rules a ON a.id = r.rule_id "
            "WHERE r.rule_id=? ORDER BY r.matched_at DESC",
            (rule_id,)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT r.*, a.name as rule_name, a.category FROM alert_results r "
            "JOIN alert_rules a ON a.id = r.rule_id "
            "ORDER BY r.matched_at DESC LIMIT 200"
        ).fetchall()
    conn.close()
    return {"results": [dict(r) for r in rows]}


@router.delete("/results/{result_id}")
def delete_result(result_id: int):
    conn = get_db()
    conn.execute("DELETE FROM alert_results WHERE id=?", (result_id,))
    conn.commit()
    conn.close()
    return {"status": "deleted"}


# ------------------------------------------------------------------ #
# Scan                                                                 #
# ------------------------------------------------------------------ #

def _build_scan_prompt(content: str, rule: dict) -> str:
    return (
        "/no_think\n"
        "تو یک سیستم هشدار خبری هستی. مشخص کن آیا متن خبر با هشدار مرتبط است.\n\n"
        f"هشدار:\n"
        f"  نام: {rule['name']}\n"
        f"  دسته‌بندی: {rule['category']}\n"
        f"  کلیدواژه‌ها: {rule['keywords']}\n"
        f"  توضیحات: {rule['description']}\n\n"
        f"متن خبر:\n{content[:3000]}\n\n"
        "پاسخ دقیقاً به این شکل:\n"
        "MATCH: YES یا NO\n"
        "REASON: (یک جمله)\n"
        "EXCERPT: (عبارت مرتبط از متن)\n"
        "به فارسی بنویس"
        "/no_think"
    )


def _parse_llm_response(text: str) -> dict:
    matched = False
    reason  = ""
    excerpt = ""
    for line in text.strip().splitlines():
        if line.startswith("MATCH:"):
            matched = "YES" in line.upper()
        elif line.startswith("REASON:"):
            reason = line.split(":", 1)[1].strip()
        elif line.startswith("EXCERPT:"):
            excerpt = line.split(":", 1)[1].strip()
    return {"matched": matched, "reason": reason, "excerpt": excerpt}


@router.post("/scan")
async def scan_url(req: ScanRequest):
    """Scan a URL or RSS feed against alert rules using LLM."""

    # ── 1. Check Ollama first ──────────────────────────────────────
    if not check_ollama(req.ollama_url):
        raise HTTPException(
            status_code=503,
            detail=f"Ollama در دسترس نیست ({req.ollama_url}). لطفاً 'ollama serve' را اجرا کنید."
        )

    # ── 2. Load rules ──────────────────────────────────────────────
    conn = get_db()
    if req.rule_ids:
        placeholders = ",".join("?" * len(req.rule_ids))
        rules = conn.execute(
            f"SELECT * FROM alert_rules WHERE id IN ({placeholders})",
            req.rule_ids
        ).fetchall()
    else:
        rules = conn.execute("SELECT * FROM alert_rules").fetchall()
    conn.close()

    if not rules:
        raise HTTPException(status_code=400, detail="هیچ قانون هشداری تعریف نشده است.")

    # ── 3. Fetch content ───────────────────────────────────────────
    articles = []
    if is_rss_url(req.url):
        try:
            feed_items = fetch_rss(req.url, req.max_rss_items)
            for item in feed_items:
                articles.append({
                    "url":     item["url"],
                    "title":   item["title"],
                    "content": item["summary"],
                })
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"خطا در خواندن RSS: {e}")
    else:
        try:
            fetched = fetch_article(req.url)
            articles.append({
                "url":     fetched["url"],
                "title":   fetched["title"],
                "content": fetched["text"],
            })
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"خطا در بارگذاری URL: {e}")

    if not articles:
        raise HTTPException(status_code=400, detail="محتوایی برای اسکن یافت نشد.")

    # ── 4. Run LLM matching ────────────────────────────────────────
    llm = get_llm(req.ollama_url, req.model, 0.0)
    alerts_found = []
    conn = get_db()

    for article in articles:
        for rule in rules:
            rule_dict = dict(rule)
            prompt = _build_scan_prompt(article["content"], rule_dict)

            try:
                response = await llm.ainvoke([HumanMessage(content=prompt)])
                result_text = response.content if hasattr(response, "content") else str(response)
                parsed = _parse_llm_response(result_text)
            except Exception as e:
                conn.close()
                raise HTTPException(
                    status_code=503,
                    detail=f"خطا در ارتباط با Ollama: {e}"
                )

            if parsed["matched"]:
                conn.execute(
                    "INSERT INTO alert_results (rule_id, source_url, title, excerpt) VALUES (?,?,?,?)",
                    (rule_dict["id"], article["url"], article["title"], parsed["excerpt"]),
                )
                conn.commit()
                alerts_found.append({
                    "rule_id":   rule_dict["id"],
                    "rule_name": rule_dict["name"],
                    "category":  rule_dict["category"],
                    "url":       article["url"],
                    "title":     article["title"],
                    "reason":    parsed["reason"],
                    "excerpt":   parsed["excerpt"],
                })

    conn.close()

    return {
        "articles_scanned": len(articles),
        "rules_checked":    len(rules),
        "alerts_found":     len(alerts_found),
        "alerts":           alerts_found,
    }


# ------------------------------------------------------------------ #
# Scan — SSE streaming                                                 #
# ------------------------------------------------------------------ #

def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/scan/stream")
async def scan_url_stream(req: ScanRequest):
    """Same as /scan but streams SSE events per article."""

    if not check_ollama(req.ollama_url):
        raise HTTPException(
            status_code=503,
            detail=f"Ollama در دسترس نیست ({req.ollama_url}). لطفاً 'ollama serve' را اجرا کنید."
        )

    conn = get_db()
    if req.rule_ids:
        placeholders = ",".join("?" * len(req.rule_ids))
        rules = conn.execute(
            f"SELECT * FROM alert_rules WHERE id IN ({placeholders})",
            req.rule_ids
        ).fetchall()
    else:
        rules = conn.execute("SELECT * FROM alert_rules").fetchall()
    conn.close()

    if not rules:
        raise HTTPException(status_code=400, detail="هیچ قانون هشداری تعریف نشده است.")

    async def generate() -> AsyncGenerator[str, None]:
        # ── Fetch content ──────────────────────────────────────────
        articles = []
        if is_rss_url(req.url):
            yield _sse({"status": "fetching", "msg": "در حال دریافت فید RSS..."})
            await asyncio.sleep(0)
            try:
                feed_items = await asyncio.to_thread(fetch_rss, req.url, req.max_rss_items)
                for item in feed_items:
                    articles.append({
                        "url":     item["url"],
                        "title":   item["title"],
                        "content": item["summary"],
                    })
                yield _sse({"status": "fetched", "msg": f"{len(articles)} خبر دریافت شد", "total": len(articles)})
                await asyncio.sleep(0)
            except Exception as e:
                yield _sse({"error": f"خطا در خواندن RSS: {e}"})
                return
        else:
            yield _sse({"status": "fetching", "msg": "در حال بارگذاری مقاله..."})
            await asyncio.sleep(0)
            try:
                fetched = await asyncio.to_thread(fetch_article, req.url)
                articles.append({
                    "url":     fetched["url"],
                    "title":   fetched["title"],
                    "content": fetched["text"],
                })
                yield _sse({"status": "fetched", "msg": "مقاله بارگذاری شد", "total": 1})
                await asyncio.sleep(0)
            except Exception as e:
                yield _sse({"error": f"خطا در بارگذاری URL: {e}"})
                return

        if not articles:
            yield _sse({"error": "محتوایی برای اسکن یافت نشد."})
            return

        # ── LLM matching ───────────────────────────────────────────
        llm = get_llm(req.ollama_url, req.model, 0.0)
        rules_list = [dict(r) for r in rules]
        total_articles = len(articles)
        alerts_found = 0

        for a_idx, article in enumerate(articles):
            yield _sse({
                "status": "scanning",
                "msg": f"تحلیل خبر {a_idx + 1} از {total_articles}: {article['title'] or article['url']}",
                "article_index": a_idx,
                "total": total_articles,
            })
            await asyncio.sleep(0)

            for rule in rules_list:
                prompt = _build_scan_prompt(article["content"], rule)
                try:
                    response = await llm.ainvoke([HumanMessage(content=prompt)])
                    result_text = response.content if hasattr(response, "content") else str(response)
                    parsed = _parse_llm_response(result_text)
                except Exception as e:
                    yield _sse({"error": f"خطا در ارتباط با Ollama: {e}"})
                    return

                if parsed["matched"]:
                    alerts_found += 1
                    db = get_db()
                    db.execute(
                        "INSERT INTO alert_results (rule_id, source_url, title, excerpt) VALUES (?,?,?,?)",
                        (rule["id"], article["url"], article["title"], parsed["excerpt"]),
                    )
                    db.commit()
                    db.close()

                    yield _sse({
                        "status": "alert",
                        "alert": {
                            "rule_id":   rule["id"],
                            "rule_name": rule["name"],
                            "category":  rule["category"],
                            "url":       article["url"],
                            "title":     article["title"],
                            "reason":    parsed["reason"],
                            "excerpt":   parsed["excerpt"],
                        }
                    })
                    await asyncio.sleep(0)

        yield _sse({
            "status": "done",
            "articles_scanned": total_articles,
            "rules_checked":    len(rules_list),
            "alerts_found":     alerts_found,
        })

    return StreamingResponse(generate(), media_type="text/event-stream")
