"""make_news_cache.py — снимок новостей по эмитентам для карточек веб-приложения.

Тянет RSS (news_config.NEWS_FEEDS + DISCLOSURE_FEEDS), привязывает каждую
новость к тикеру по ключевым словам (news.match_tickers) и пишет:
  web/public/news-cache.json = [{ticker,title,url,published,source,summary,sentiment?,impact?}]

По умолчанию БЕЗ LLM (быстро, без ключей). С флагом --analyze прогоняет
заголовки через news.analyze_news (Yandex/Cerebras по настройке в settings.ini)
и добавляет тональность/влияние — это тратит запросы к LLM.

Запуск из invest-bot:
    py -3.11 make_news_cache.py            # только заголовки, быстро
    py -3.11 make_news_cache.py --analyze  # + тональность через LLM
"""
from __future__ import annotations

import json
import os
import sys
from urllib.parse import urlparse

from news_config import NEWS_FEEDS, DISCLOSURE_FEEDS
from news import _fetch_feed, parse_rss, match_tickers

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(_ROOT, "web", "public")
MAX_ITEMS = 400          # общий предел, чтобы файл не разрастался
PER_TICKER = 40          # не больше N новостей на эмитента


def _source(url: str) -> str:
    try:
        host = urlparse(url).netloc.replace("www.", "")
        return host or "rss"
    except Exception:
        return "rss"


def main():
    analyze = "--analyze" in sys.argv
    if analyze:
        from news import analyze_news

    seen = set()          # дедуп по (ticker, title)
    out = []
    for url in list(NEWS_FEEDS) + list(DISCLOSURE_FEEDS):
        raw = _fetch_feed(url)
        if not raw:
            print(f"[news] пропущен фид: {url}", file=sys.stderr)
            continue
        src = _source(url)
        for it in parse_rss(raw):
            text = it["title"] + " " + it.get("summary", "")
            tickers = match_tickers(text)
            if not tickers:
                continue
            for tk in tickers:
                key = (tk, it["title"])
                if key in seen:
                    continue
                seen.add(key)
                rec = {
                    "ticker": tk,
                    "title": it["title"],
                    "url": it.get("link", ""),
                    "published": it.get("published", ""),
                    "source": src,
                    "summary": it.get("summary", ""),
                }
                if analyze:
                    try:
                        a = analyze_news(it["title"], it.get("summary", ""), tk)
                        # analyze_news возвращает dict; берём тональность/влияние гибко
                        rec["sentiment"] = a.get("sentiment") or a.get("тональность")
                        rec["impact"] = a.get("impact") or a.get("влияние")
                    except Exception as e:
                        print(f"[news] analyze {tk}: {e}", file=sys.stderr)
                out.append(rec)

    # свежие сверху, лимит на тикер и общий
    out.sort(key=lambda r: r.get("published", ""), reverse=True)
    per = {}
    capped = []
    for r in out:
        c = per.get(r["ticker"], 0)
        if c >= PER_TICKER:
            continue
        per[r["ticker"]] = c + 1
        capped.append(r)
        if len(capped) >= MAX_ITEMS:
            break

    os.makedirs(PUB, exist_ok=True)
    path = os.path.join(PUB, "news-cache.json")
    json.dump(capped, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"[news] новостей: {len(capped)} по {len(per)} эмитентам → {path}", file=sys.stderr)
    print("[news] ГОТОВО. Обнови веб — новости появятся в карточках эмитентов.", file=sys.stderr)


if __name__ == "__main__":
    main()
