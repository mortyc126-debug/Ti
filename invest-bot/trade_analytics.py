"""
trade_analytics.py — Анализ истории торговли.

Два источника данных:
  1. data/archive.json  — ArchiveStore: composite/quality/режим по дням (всегда)
  2. data/trades.jsonl  — metrics.py: реальные PnL/WR/Kelly (накапливается в sandbox)

Функции:
  ticker_summary(ticker)  — сводка по тикеру из архива (для council)
  trades_summary()        — статистика реальных сделок (WR, PF, Kelly, fitness)
  all_tickers_summary()   — топ тикеров по quality (для Telegram)
  full_report_for_council(ticker) — всё вместе, для агентов
"""

import json
import logging
import os
from collections import defaultdict
from datetime import datetime, timedelta

import metrics

logger = logging.getLogger(__name__)

ARCHIVE_FILE = "data/archive.json"


def _load() -> dict:
    if not os.path.exists(ARCHIVE_FILE):
        return {}
    try:
        with open(ARCHIVE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"trade_analytics: {e}")
        return {}


def ticker_summary(ticker: str, days: int = 30) -> str:
    """
    Краткая текстовая сводка по тикеру за последние N дней.
    Используется council.py как «что мы знаем об этом тикере».
    """
    archive = _load()
    ticker_data = archive.get(ticker, {})
    if not ticker_data:
        return f"Нет данных по {ticker} в архиве наблюдений."

    cutoff = (datetime.now() - timedelta(days=days)).date().isoformat()
    recent = {d: s for d, s in ticker_data.items() if d >= cutoff}

    if not recent:
        return f"Нет данных по {ticker} за последние {days} дней."

    composites = [s["composite"] for s in recent.values() if "composite" in s]
    qualities = [s["rolling_quality"] for s in recent.values() if "rolling_quality" in s]
    regimes = defaultdict(int)
    narratives = defaultdict(int)
    for s in recent.values():
        if "regime" in s:
            regimes[s["regime"]] += 1
        if s.get("narrative_state"):
            narratives[s["narrative_state"]] += 1

    live_days = sum(1 for s in recent.values() if s.get("live"))
    noise_days = sum(1 for s in recent.values() if s.get("noise_mode"))
    ic_warm_days = sum(1 for s in recent.values() if s.get("ic_warm"))

    avg_comp = sum(composites) / len(composites) if composites else 0
    avg_qual = sum(qualities) / len(qualities) if qualities else 0
    dominant_regime = max(regimes, key=regimes.get) if regimes else "?"
    dominant_narrative = max(narratives, key=narratives.get) if narratives else "?"

    lines = [
        f"{len(recent)} дней наблюдений за {ticker} (последние {days} дн.):",
        f"  Ср. композит: {avg_comp:+.3f} | Ср. quality: {avg_qual:.3f}",
        f"  Режим (часто): {dominant_regime} "
        f"({regimes.get(dominant_regime, 0)} дн.) | Режимы: "
        + ", ".join(f"{r}:{n}" for r, n in sorted(regimes.items(), key=lambda x: -x[1])),
        f"  Нарратив: {dominant_narrative}",
        f"  Реальных сделок (live): {live_days} дн. | "
        f"Шум-режим: {noise_days} дн. | IC прогрет: {ic_warm_days} дн.",
    ]

    # Backtest из последнего снапшота
    last_date = max(ticker_data.keys())
    last_snap = ticker_data[last_date]
    bq = last_snap.get("backtest_quality")
    bt = last_snap.get("backtest_trades")
    if bq is not None:
        lines.append(f"  Backtest quality: {bq:.3f} по {bt or '?'} сделкам ({last_date})")

    # Динамика качества (есть ли тренд?)
    if len(qualities) >= 5:
        first_half = qualities[: len(qualities) // 2]
        second_half = qualities[len(qualities) // 2 :]
        avg_first = sum(first_half) / len(first_half)
        avg_second = sum(second_half) / len(second_half)
        trend = avg_second - avg_first
        sign = "↑" if trend > 0.02 else "↓" if trend < -0.02 else "→"
        lines.append(f"  Динамика quality: {sign} ({avg_first:.3f} → {avg_second:.3f})")

    return "\n".join(lines)


def all_tickers_summary(top: int = 8) -> str:
    """
    Сводка по всем тикерам за последнюю неделю — топ-N по rolling_quality.
    Используется для ежедневного Telegram-репорта.
    """
    archive = _load()
    cutoff = (datetime.now() - timedelta(days=7)).date().isoformat()

    rows = []
    for ticker, dates in archive.items():
        recent = {d: s for d, s in dates.items() if d >= cutoff}
        if not recent:
            continue
        quals = [s.get("rolling_quality", 0) for s in recent.values()]
        comps = [s.get("composite", 0) for s in recent.values()]
        avg_q = sum(quals) / len(quals) if quals else 0
        avg_c = sum(comps) / len(comps) if comps else 0
        live = any(s.get("live") for s in recent.values())
        rows.append((ticker, avg_q, avg_c, live, len(recent)))

    rows.sort(key=lambda x: -x[1])
    top_rows = rows[:top]

    if not top_rows:
        return "Нет данных за последнюю неделю."

    lines = ["📊 Топ тикеров за 7 дней (rolling_quality):"]
    for ticker, q, comp, live, n in top_rows:
        marker = "🟢" if live else "📡"
        lines.append(f"  {marker} {ticker:<6} q={q:.3f} comp={comp:+.3f} ({n} дн.)")
    return "\n".join(lines)


def tickers_with_weak_signal(threshold: float = 0.3) -> list[str]:
    """Тикеры у которых rolling_quality < threshold за последние 7 дней — для предупреждений."""
    archive = _load()
    cutoff = (datetime.now() - timedelta(days=7)).date().isoformat()
    weak = []
    for ticker, dates in archive.items():
        recent = {d: s for d, s in dates.items() if d >= cutoff}
        if not recent:
            continue
        quals = [s.get("rolling_quality", 0) for s in recent.values()]
        avg_q = sum(quals) / len(quals) if quals else 0
        if avg_q < threshold:
            weak.append(ticker)
    return weak


def trades_summary(equity_rub: float | None = None) -> str:
    """
    Сводка реальных сделок из data/trades.jsonl.
    Включает: fitness scorecard, win rate, profit factor, Kelly, по тикерам.
    Используется sandbox_monitor (Telegram) и council (контекст для агентов).
    """
    lines = [metrics.scorecard_text(equity_rub=equity_rub)]

    # По тикерам
    per_ticker = metrics.per_ticker_stats(top=5)
    if "Сделок пока нет" not in per_ticker:
        lines.append(per_ticker)

    # ½-Келли рекомендация
    pct, why = metrics.dynamic_risk_pct()
    lines.append(f"📐 Рекомендуемый риск/сделку (½-Келли): {pct:.2f}% | {why}")

    return "\n".join(lines)


def full_report_for_council(ticker: str) -> str:
    """
    Всё что знаем о тикере — для передачи агентам консилиума.
    Объединяет архив (composite/quality/режим) + реальные сделки (WR/PF).
    """
    parts = []

    arch = ticker_summary(ticker)
    parts.append(arch)

    # Реальные сделки по тикеру
    ticker_trades = metrics.load_ticker_trades(ticker)
    if ticker_trades:
        ts = metrics.trade_stats(ticker_trades)
        n = ts.get("n", 0)
        wr = ts.get("win_rate", 0)
        pf = ts.get("profit_factor")
        exp = ts.get("expectancy", 0)
        total = ts.get("total_pnl", 0)
        parts.append(
            f"Реальные сделки по {ticker} ({n} шт.): "
            f"WR={wr:.0%}  PF={pf or 'n/a'}  exp={exp}₽  итого={total:+.0f}₽"
        )
    else:
        parts.append(f"Реальных сделок по {ticker} в trades.jsonl пока нет.")

    # Общий fitness
    card = metrics.scorecard()
    fitness = card.get("fitness", "unproven")
    verdict = card.get("verdict", "")
    parts.append(f"Общий fitness системы: {fitness} | {verdict}")

    return "\n".join(parts)
