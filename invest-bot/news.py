"""
news.py — Сборщик, классификатор и верификатор новостей.

Цикл работы:
  1. Новость приходит из RSS → привязывается к тикеру по ключевым словам.
  2. Cerebras (llama-3.3-70b) анализирует заголовок+саммари и возвращает:
       sentiment          — тональность (very_positive … very_negative)
       expected_direction — ожидаемое направление цены (up / down / neutral)
       expected_strength  — ожидаемая сила движения (weak / moderate / strong)
       reasoning          — одна фраза: почему
  3. Фиксируется цена в момент публикации.
  4. Через 5м / 15м / 1ч / 4ч / 1д / 3д / 7д PriceTracker дописывает
     фактические цены и считает:
       direction_correct  — совпало ли направление с ожиданием
       strength_match     — совпала ли сила движения
       signal_vs_noise    — фактическое движение / фоновая волатильность
                            (>1.5 — новость реально сдвинула рынок)

Стоимость классификации: ~$0.0002 за новость (Cerebras бесплатный тир).
Требует пакет cerebras_cloud_sdk (опционально — без ключа/пакета просто
возвращает нейтральный fallback, остальной сбор новостей продолжает работать).
"""

import os
import json
import re
import asyncio
import logging
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

import ssl_setup
from email.utils import parsedate_to_datetime

from news_config import NEWS_FEEDS, TICKER_KEYWORDS, NEWS_POLL_MINUTES, DISCLOSURE_FEEDS

logger = logging.getLogger(__name__)

UA = {"User-Agent": "Mozilla/5.0 (Observer/2.1; market research)"}

# Интервалы отслеживания цены (минуты)
PRICE_TRACK_INTERVALS = [5, 15, 60, 240, 1440, 4320, 10080]
INTERVAL_LABELS = {
    5:     "5m",
    15:    "15m",
    60:    "1h",
    240:   "4h",
    1440:  "1d",
    4320:  "3d",
    10080: "7d",
}
INTERVAL_DISPLAY = {
    5:     "5м",
    15:    "15м",
    60:    "1ч",
    240:   "4ч",
    1440:  "1д",
    4320:  "3д",
    10080: "7д",
}

SENTIMENT_VALUES   = ("very_positive", "positive", "neutral", "negative", "very_negative")
DIRECTION_VALUES   = ("up", "down", "neutral")
STRENGTH_VALUES    = ("weak", "moderate", "strong")

SENTIMENT_RU = {
    "very_positive": "очень хорошая",
    "positive":      "хорошая",
    "neutral":       "нейтральная",
    "negative":      "плохая",
    "very_negative": "очень плохая",
}
SENTIMENT_EMOJI = {
    "very_positive": "🟢🟢",
    "positive":      "🟢",
    "neutral":       "⚪",
    "negative":      "🔴",
    "very_negative": "🔴🔴",
}

# Пороги для оценки силы фактического движения
STRENGTH_THRESHOLDS = {
    "weak":     0.5,   # < 0.5%
    "moderate": 2.0,   # 0.5 – 2.0%
    "strong":   9999,  # > 2.0%
}

# Порог «выбивается из шума»
SIGNAL_VS_NOISE_THR = 1.5


# ── RSS ───────────────────────────────────────────────────────────────────────

def _fetch_feed(url: str, timeout: int = 15) -> bytes | None:
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_setup.ssl_context()) as r:
            return r.read()
    except Exception as e:
        logger.warning(f"_fetch_feed {url}: {e}")
        return None


def parse_rss(raw: bytes) -> list[dict]:
    items = []
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        logger.warning(f"parse_rss: битый XML: {e}")
        return items
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        if not title:
            continue
        pub = (item.findtext("pubDate") or "").strip()
        try:
            published = parsedate_to_datetime(pub).isoformat() if pub else ""
        except (ValueError, TypeError):
            published = pub
        items.append({
            "title":     title,
            "link":      (item.findtext("link") or "").strip(),
            "published": published,
            "summary":   re.sub(r"<[^>]+>", "", item.findtext("description") or "")[:300].strip(),
        })
    return items


def match_tickers(text: str) -> list[str]:
    low = text.lower()
    return [t for t, kws in TICKER_KEYWORDS.items() if any(k in low for k in kws)]


# ── Cerebras: анализ новости ──────────────────────────────────────────────────

def analyze_news(title: str, summary: str, ticker: str) -> dict:
    """
    Анализирует новость через Cerebras и возвращает dict:
      sentiment          — very_positive / positive / neutral / negative / very_negative
      expected_direction — up / down / neutral
      expected_strength  — weak / moderate / strong
      reasoning          — одна фраза почему

    При любой ошибке (нет ключа, нет пакета, сетевая ошибка) возвращает
    нейтральный результат — сбор новостей не прерывается.
    """
    fallback = {
        "sentiment":          "neutral",
        "expected_direction": "neutral",
        "expected_strength":  "weak",
        "reasoning":          "ошибка классификации",
    }
    try:
        from cerebras.cloud.sdk import Cerebras
        from news_config import CEREBRAS_API_KEY

        api_key = CEREBRAS_API_KEY
        if not api_key:
            logger.warning("CEREBRAS_API_KEY не задан")
            return fallback

        client = Cerebras(api_key=api_key)

        prompt = f"""Ты финансовый аналитик российского рынка акций.
Оцени влияние новости на акцию {ticker}.

Заголовок: {title}
Краткое содержание: {summary}

Ответь СТРОГО в формате JSON (без пояснений, без markdown):
{{
  "sentiment": "one of: very_positive / positive / neutral / negative / very_negative",
  "expected_direction": "one of: up / down / neutral",
  "expected_strength": "one of: weak / moderate / strong",
  "reasoning": "одна фраза на русском — почему именно такая оценка"
}}

Критерии expected_strength:
  weak     — ожидаемое движение < 0.5% (фоновый шум)
  moderate — ожидаемое движение 0.5–2% (заметная реакция)
  strong   — ожидаемое движение > 2% (сильный импульс)
"""

        response = client.chat.completions.create(
            model="llama-3.3-70b",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=120,
            temperature=0.0,
        )
        raw_text = response.choices[0].message.content.strip()

        # Вырезаем JSON даже если модель добавила что-то лишнее
        match = re.search(r"\{.*\}", raw_text, re.DOTALL)
        if not match:
            logger.warning(f"analyze_news: JSON не найден в ответе: {raw_text[:100]}")
            return fallback

        parsed = json.loads(match.group())

        result = {
            "sentiment":          parsed.get("sentiment", "neutral"),
            "expected_direction": parsed.get("expected_direction", "neutral"),
            "expected_strength":  parsed.get("expected_strength", "weak"),
            "reasoning":          parsed.get("reasoning", ""),
        }

        # Валидация значений
        if result["sentiment"] not in SENTIMENT_VALUES:
            result["sentiment"] = "neutral"
        if result["expected_direction"] not in DIRECTION_VALUES:
            result["expected_direction"] = "neutral"
        if result["expected_strength"] not in STRENGTH_VALUES:
            result["expected_strength"] = "weak"

        return result

    except Exception as e:
        logger.error(f"analyze_news: {e}")
        return fallback


# ── Вспомогательные функции ───────────────────────────────────────────────────

def _pct(price_now: float | None, price_base: float | None) -> float | None:
    if price_now is None or price_base is None or price_base == 0:
        return None
    return round((price_now - price_base) / price_base * 100, 4)


def _actual_strength(pct: float | None) -> str | None:
    """Переводит % движения в категорию weak / moderate / strong."""
    if pct is None:
        return None
    abs_pct = abs(pct)
    if abs_pct < STRENGTH_THRESHOLDS["weak"]:
        return "weak"
    if abs_pct < STRENGTH_THRESHOLDS["moderate"]:
        return "moderate"
    return "strong"


def get_noise_baseline(ticker: str, window_days: int = 20) -> float | None:
    """
    Фоновая волатильность тикера: средний |pct_1d| по дням БЕЗ новостей
    за последние window_days дней.

    Используется для расчёта signal_vs_noise:
        signal_vs_noise = |pct_1d новости| / noise_baseline
    Значение > 1.5 означает, что движение выбивается из обычного шума.

    Если данных недостаточно — возвращает None.
    """
    entries = load_news(ticker)
    if not entries:
        return None

    # Собираем даты дней, в которые выходили новости
    news_days: set[str] = set()
    for e in entries:
        d = (e.get("published") or e.get("ts") or "")[:10]
        if d:
            news_days.add(d)

    # Берём записи с заполненным pct_1d, дата которых НЕ в news_days
    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=window_days)
    quiet_moves: list[float] = []

    for e in entries:
        d = (e.get("published") or e.get("ts") or "")[:10]
        if d in news_days:
            continue
        ts_str = e.get("published") or e.get("ts") or ""
        try:
            ts = datetime.fromisoformat(ts_str)
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if ts < cutoff:
                continue
        except ValueError:
            continue
        v = e.get("pct_1d")
        if v is not None:
            quiet_moves.append(abs(v))

    if len(quiet_moves) < 5:
        return None
    return round(sum(quiet_moves) / len(quiet_moves), 4)


def _evaluate_prediction(entry: dict, interval_min: int, pct: float | None) -> dict:
    """
    Сравнивает прогноз Cerebras с фактическим движением цены.
    Возвращает dict с полями для дописывания в news.jsonl.
    """
    label = INTERVAL_LABELS[interval_min]
    result: dict = {}

    if pct is None:
        return result

    expected_dir = entry.get("expected_direction", "neutral")
    expected_str = entry.get("expected_strength", "weak")
    actual_str   = _actual_strength(pct)

    # Направление: up = рост, down = падение
    actual_dir = "up" if pct > 0 else ("down" if pct < 0 else "neutral")

    direction_correct = (
        expected_dir == "neutral" or
        actual_dir   == "neutral" or
        expected_dir == actual_dir
    )
    strength_match = (expected_str == actual_str)

    result[f"direction_correct_{label}"] = direction_correct
    result[f"strength_match_{label}"]    = strength_match
    result[f"actual_strength_{label}"]   = actual_str

    return result


# ── Ценовой трекинг ───────────────────────────────────────────────────────────

class PriceTracker:
    """
    Очередь заданий на отслеживание цены после выхода новости.
    При каждом poll() проверяет наступившие интервалы, дописывает
    цену, %, и результат проверки прогноза в news.jsonl.

    Файл очереди: data/_price_track.json
    Задание живёт до 7 дней (пока не собраны все интервалы).
    """

    TRACK_FILE = "data/_price_track.json"

    def __init__(self, price_getter):
        self.price_getter = price_getter
        self._pending: list[dict] = []
        self._load()

    def _load(self):
        if os.path.exists(self.TRACK_FILE):
            try:
                with open(self.TRACK_FILE, encoding="utf-8") as f:
                    self._pending = json.load(f)
            except (json.JSONDecodeError, TypeError):
                self._pending = []

    def _save(self):
        from atomic_json import atomic_write_json
        atomic_write_json(self.TRACK_FILE, self._pending, indent=2)

    def add(self, ticker: str, news_link: str, saved_at: str, price_at_save: float | None):
        self._pending.append({
            "ticker":        ticker,
            "news_link":     news_link,
            "saved_at":      saved_at,
            "price_at_save": price_at_save,
            "done":          [],
        })
        self._save()

    def poll(self):
        if not self._pending:
            return

        now = datetime.now(tz=timezone.utc)
        still_pending = []

        for job in self._pending:
            saved_at = datetime.fromisoformat(job["saved_at"])
            if saved_at.tzinfo is None:
                saved_at = saved_at.replace(tzinfo=timezone.utc)

            elapsed_min = (now - saved_at).total_seconds() / 60
            all_collected = True

            for m in PRICE_TRACK_INTERVALS:
                key = str(m)
                if key in job["done"]:
                    continue
                all_collected = False
                if elapsed_min >= m:
                    price_now = self.price_getter(job["ticker"])
                    pct       = _pct(price_now, job["price_at_save"])
                    job["done"].append(key)
                    self._patch_news_entry(job["ticker"], job["news_link"], m, price_now, pct)
                    logger.info(
                        f"price_track {job['ticker']} +{INTERVAL_DISPLAY[m]}: "
                        f"{job['price_at_save']} → {price_now} ({pct}%)"
                    )

            if not all_collected:
                still_pending.append(job)

        self._pending = still_pending
        self._save()

    def _patch_news_entry(
        self,
        ticker: str,
        news_link: str,
        interval_min: int,
        price_now: float | None,
        pct: float | None,
    ):
        """Дописывает цену, %, оценку прогноза и signal_vs_noise в news.jsonl."""
        path = f"data/{ticker}/news.jsonl"
        if not os.path.exists(path):
            return

        label     = INTERVAL_LABELS[interval_min]
        key_price = f"price_{label}"
        key_pct   = f"pct_{label}"
        updated   = []

        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.rstrip("\n")
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    updated.append(line)
                    continue

                if entry.get("link") == news_link and key_price not in entry:
                    entry[key_price] = price_now
                    entry[key_pct]   = pct
                    # Проверка прогноза
                    entry.update(_evaluate_prediction(entry, interval_min, pct))
                    # signal_vs_noise считаем только для интервала 1д
                    if interval_min == 1440 and pct is not None:
                        baseline = get_noise_baseline(ticker)
                        if baseline and baseline > 0:
                            entry["signal_vs_noise_1d"] = round(abs(pct) / baseline, 3)
                    line = json.dumps(entry, ensure_ascii=False)

                updated.append(line)

        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(updated) + "\n")


# ── Основной коллектор ────────────────────────────────────────────────────────

class NewsCollector:
    """
    Собирает новости, анализирует через Cerebras, фиксирует цену
    и раскладывает по data/{ticker}/news.jsonl.

    price_getter(ticker) -> float|None — функция получения текущей цены
    по человеческому тикеру (см. wiring в main.py: InstrumentService.share_by_ticker
    + MarketDataService.get_last_price).
    """

    def __init__(self, price_getter=None):
        self.price_getter = price_getter or (lambda ticker: None)
        self._seen: set[str] = set()
        self._load_seen()
        self._tracker = PriceTracker(self.price_getter)

    SEEN_FILE = "data/_news_seen.json"

    def _load_seen(self):
        if os.path.exists(self.SEEN_FILE):
            try:
                with open(self.SEEN_FILE, encoding="utf-8") as f:
                    self._seen = set(json.load(f)[-2000:])
            except (json.JSONDecodeError, TypeError):
                self._seen = set()

    def _save_seen(self):
        from atomic_json import atomic_write_json
        atomic_write_json(self.SEEN_FILE, list(self._seen)[-2000:])

    def poll_once(self) -> int:
        self._tracker.poll()
        saved = 0
        for url in list(NEWS_FEEDS) + list(DISCLOSURE_FEEDS):
            raw = _fetch_feed(url)
            if not raw:
                continue
            for item in parse_rss(raw):
                key = item["link"] or item["title"]
                if key in self._seen:
                    continue
                self._seen.add(key)
                tickers = match_tickers(item["title"] + " " + item["summary"])
                for ticker in tickers:
                    self._save_news(ticker, item)
                    saved += 1
        self._save_seen()
        if saved:
            logger.info(f"poll_once: {saved} новых новостей привязано к тикерам")
        return saved

    def _save_news(self, ticker: str, item: dict):
        os.makedirs(f"data/{ticker}", exist_ok=True)
        saved_at  = datetime.now(tz=timezone.utc).isoformat()
        price_now = self.price_getter(ticker)

        analysis = analyze_news(item["title"], item["summary"], ticker)

        entry = {
            "ts":                 saved_at,
            "published":          item["published"],
            "title":              item["title"],
            "link":               item["link"],
            "summary":            item["summary"],
            # --- прогноз Cerebras ---
            "sentiment":          analysis["sentiment"],
            "sentiment_ru":       SENTIMENT_RU[analysis["sentiment"]],
            "expected_direction": analysis["expected_direction"],
            "expected_strength":  analysis["expected_strength"],
            "reasoning":          analysis["reasoning"],
            # --- цена на момент публикации ---
            "price_at_save":      price_now,
            # price_5m / pct_5m / direction_correct_5m / ... допишет PriceTracker
        }

        with open(f"data/{ticker}/news.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        emoji = SENTIMENT_EMOJI[analysis["sentiment"]]
        dir_arrow = {"up": "↑", "down": "↓", "neutral": "→"}[analysis["expected_direction"]]
        logger.info(
            f"[НОВОСТЬ] {ticker} @ {price_now} {emoji} {dir_arrow}"
            f"({analysis['expected_strength']})  {item['title'][:65]} — {analysis['reasoning']}"
        )

        self._tracker.add(ticker, item["link"], saved_at, price_now)

    async def run_forever(self):
        logger.info(f"NewsCollector запущен, интервал {NEWS_POLL_MINUTES} мин")
        while True:
            try:
                await asyncio.to_thread(self.poll_once)
            except Exception as e:
                logger.error(f"run_forever: {e}")
            await asyncio.sleep(NEWS_POLL_MINUTES * 60)


# ── Чтение, сортировка, аналитика ─────────────────────────────────────────────

def load_news(ticker: str) -> list[dict]:
    path = f"data/{ticker}/news.jsonl"
    if not os.path.exists(path):
        return []
    entries = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return entries


def sort_news(entries: list[dict], by: str = "published", ascending: bool = False) -> list[dict]:
    """
    by: published | ts | sentiment | expected_strength |
        pct_5m | pct_15m | pct_1h | pct_4h | pct_1d | pct_3d | pct_7d |
        signal_vs_noise_1d
    """
    SENTIMENT_ORDER = {s: i for i, s in enumerate(SENTIMENT_VALUES)}
    STRENGTH_ORDER  = {"weak": 0, "moderate": 1, "strong": 2}
    PCT_KEYS = {f"pct_{lbl}" for lbl in INTERVAL_LABELS.values()} | {"signal_vs_noise_1d"}

    def key_fn(e: dict):
        if by in PCT_KEYS:
            v = e.get(by)
            return abs(v) if v is not None else -1.0
        if by == "sentiment":
            return SENTIMENT_ORDER.get(e.get("sentiment", "neutral"), 2)
        if by == "expected_strength":
            return STRENGTH_ORDER.get(e.get("expected_strength", "weak"), 0)
        return e.get(by) or ""

    return sorted(entries, key=key_fn, reverse=not ascending)


def read_recent_news(ticker: str, n: int = 5, sort_by: str = "published") -> str:
    """Последние N новостей с прогнозом, фактикой и проверкой."""
    entries = load_news(ticker)
    if not entries:
        return ""

    entries = sort_news(entries, by=sort_by)[:n]
    lines = []

    for e in entries:
        p0       = e.get("price_at_save")
        sent     = SENTIMENT_RU.get(e.get("sentiment", "neutral"), "нейтральная")
        exp_dir  = e.get("expected_direction", "?")
        exp_str  = e.get("expected_strength", "?")
        reasoning = e.get("reasoning", "")
        date_str = (e.get("published") or e.get("ts") or "")[:16]

        # Ценовые данные по интервалам
        price_parts = []
        for m, lbl in INTERVAL_LABELS.items():
            pv = e.get(f"price_{lbl}")
            dv = e.get(f"pct_{lbl}")
            dc = e.get(f"direction_correct_{lbl}")
            sm = e.get(f"strength_match_{lbl}")
            if pv is None:
                continue
            sign    = "+" if (dv or 0) >= 0 else ""
            pct_str = f"{sign}{dv:.2f}%" if dv is not None else "?"
            check   = ""
            if dc is not None:
                check = " ✓" if dc else " ✗"
            if sm is not None:
                check += "✓" if sm else "✗"
            price_parts.append(f"+{INTERVAL_DISPLAY[m]} {pv}({pct_str}){check}")

        svn = e.get("signal_vs_noise_1d")
        svn_str = f"  сигнал/шум: {svn:.2f}" if svn is not None else ""

        price_line = f"цена: {p0}" + (" → " + " | ".join(price_parts) if price_parts else "")
        lines.append(
            f"- [{date_str}] [{sent}] {e['title']}\n"
            f"  прогноз: {exp_dir} / {exp_str} — {reasoning}\n"
            f"  {price_line}{svn_str}"
        )

    return "\n".join(lines)


def get_prediction_accuracy(ticker: str) -> dict:
    """
    Точность прогнозов Cerebras по тикеру.
    Считает % верных направлений и совпадений силы по каждому интервалу.
    """
    entries = load_news(ticker)
    result  = {"ticker": ticker, "total": len(entries)}

    for m, lbl in INTERVAL_LABELS.items():
        dc_key = f"direction_correct_{lbl}"
        sm_key = f"strength_match_{lbl}"
        dc_list = [e[dc_key] for e in entries if dc_key in e]
        sm_list = [e[sm_key] for e in entries if sm_key in e]
        result[f"direction_accuracy_{lbl}"] = (
            round(sum(dc_list) / len(dc_list) * 100, 1) if dc_list else None
        )
        result[f"strength_accuracy_{lbl}"] = (
            round(sum(sm_list) / len(sm_list) * 100, 1) if sm_list else None
        )
        result[f"samples_{lbl}"] = len(dc_list)

    return result


def get_price_impact_summary(ticker: str) -> dict:
    """Медианы движения цены и разбивка по тональности."""
    entries = load_news(ticker)
    pct_keys = [f"pct_{lbl}" for lbl in INTERVAL_LABELS.values()]
    buckets: dict[str, list[float]] = {k: [] for k in pct_keys}
    by_sentiment: dict[str, int]    = {s: 0 for s in SENTIMENT_VALUES}

    for e in entries:
        sent = e.get("sentiment", "neutral")
        if sent in by_sentiment:
            by_sentiment[sent] += 1
        for k in pct_keys:
            v = e.get(k)
            if v is not None:
                buckets[k].append(v)

    def median(lst):
        if not lst:
            return None
        s = sorted(lst)
        mid = len(s) // 2
        return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2

    out = {"ticker": ticker, "total_news": len(entries), "by_sentiment": by_sentiment}
    for k in pct_keys:
        out[f"median_{k}"] = median(buckets[k])
        out[f"samples_{k}"] = len(buckets[k])
    return out


def news_council_summary(ticker: str, n: int = 3) -> str:
    """
    Компактный новостной блок для консилиума (council.consult_signal, поле
    analytics_text): свежие N новостей с прогнозом/фактикой + историческая
    точность прогнозов Cerebras на 1-дневном горизонте (сколько сделано и
    какой % верного направления). Пустая строка, если новостей по тикеру нет —
    тогда в консилиум ничего лишнего не уходит.
    """
    recent = read_recent_news(ticker, n=n)
    if not recent:
        return ""

    acc = get_prediction_accuracy(ticker)
    acc_line = ""
    # 1d — самый показательный горизонт для внутридневной торговли
    d1 = acc.get("direction_accuracy_1d")
    n1 = acc.get("samples_1d") or 0
    if d1 is not None and n1 >= 5:
        acc_line = f"\nИсторическая точность прогнозов новостей (1д): {d1:.0f}% на {n1} наблюдениях."

    return f"🗞 Новостной фон по {ticker} (свежие {n}):\n{recent}{acc_line}"
