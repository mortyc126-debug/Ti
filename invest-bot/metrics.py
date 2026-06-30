"""
metrics.py — Статистика реальных сделок (win rate, expectancy, Kelly, profit factor).

Читает data/trades.jsonl — файл пишется trader.py при каждом открытии/закрытии.
Формат строки: {"event":"open"|"close", "ticker":..., "pnl_rub":..., ...}

Используется:
  - council.py  — scorecard передаётся агентам как «объективный KPI системы»
  - trade_analytics.py — trades_summary() для отчётов
  - sandbox_monitor.py — итог дня в Telegram
  - (будущее) динамический размер позиции по ½-Келли

½-Келли — стандарт индустрии: даёт ~75% роста от полного Келли при вдвое
меньших просадках. Полный Келли слишком агрессивен для реального трейдинга.
"""

import json
import logging
import os
from datetime import datetime

logger = logging.getLogger(__name__)

TRADES_FILE = "data/trades.jsonl"
MIN_TRADES_FOR_KELLY = 10   # до этого числа сделок — базовый риск

# Параметры Kelly / fitness (согласованы с risk_config.py)
RISK_BASE_PCT = 1.0   # базовый риск % (до накопления статистики)
RISK_MIN_PCT = 0.5
RISK_MAX_PCT = 1.5
KELLY_FRACTION = 0.5  # ½-Келли

# Fitness-окно и пороги
FITNESS_WINDOW = 20          # сколько последних сделок оцениваем
FITNESS_PF_GOOD = 1.5        # профит-фактор «здоровой» системы
FITNESS_PF_BAD = 1.0         # профит-фактор «слабой»
FITNESS_MAX_DD_PCT = 10.0    # порог просадки депо в % (для weak-вердикта)


# ── Чтение сделок ────────────────────────────────────────────────────────────

def load_closed_trades(n: int = 200) -> list[dict]:
    """Последние n закрытых сделок из trades.jsonl."""
    if not os.path.exists(TRADES_FILE):
        return []
    out = []
    try:
        with open(TRADES_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    t = json.loads(line)
                    if t.get("event") == "close" and "pnl_rub" in t:
                        out.append(t)
                except json.JSONDecodeError:
                    pass
    except OSError as e:
        logger.warning(f"metrics: {e}")
    return out[-n:]


def load_ticker_trades(ticker: str, n: int = 100) -> list[dict]:
    """Закрытые сделки по конкретному тикеру."""
    return [t for t in load_closed_trades(5000) if t.get("ticker") == ticker][-n:]


# ── Запись сделки ─────────────────────────────────────────────────────────────

def log_trade(event: str, data: dict) -> None:
    """
    Добавляет строку в data/trades.jsonl.
    event: "open" | "close" | "reduce"
    data: dict с полями ticker, direction, qty, pnl_rub (для close), ...
    """
    os.makedirs("data", exist_ok=True)
    record = {"event": event, "ts": datetime.now().isoformat(), **data}
    try:
        with open(TRADES_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError as e:
        logger.warning(f"metrics log_trade: {e}")


# ── Статистика ────────────────────────────────────────────────────────────────

def trade_stats(trades: list[dict] | None = None, n: int = 200) -> dict:
    """Сводная статистика закрытых сделок."""
    if trades is None:
        trades = load_closed_trades(n)
    pnls = [t["pnl_rub"] for t in trades]
    if not pnls:
        return {"n": 0}

    wins = [p for p in pnls if p > 0]
    losses = [-p for p in pnls if p < 0]
    gross_win = sum(wins)
    gross_loss = sum(losses)

    win_rate = len(wins) / len(pnls)
    avg_win = gross_win / len(wins) if wins else 0.0
    avg_loss = gross_loss / len(losses) if losses else 0.0

    equity, peak, max_dd = 0.0, 0.0, 0.0
    for p in pnls:
        equity += p
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)

    return {
        "n": len(pnls),
        "win_rate": round(win_rate, 3),
        "avg_win": round(avg_win, 2),
        "avg_loss": round(avg_loss, 2),
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else None,
        "expectancy": round(sum(pnls) / len(pnls), 2),
        "total_pnl": round(sum(pnls), 2),
        "max_drawdown": round(max_dd, 2),
    }


def kelly_fraction(win_rate: float, payoff_ratio: float) -> float:
    """f* = W − (1−W)/R. Может быть отрицательным (система убыточная)."""
    if payoff_ratio <= 0:
        return 0.0
    return win_rate - (1 - win_rate) / payoff_ratio


def dynamic_risk_pct(trades: list[dict] | None = None) -> tuple[float, str]:
    """
    Риск на сделку (% депо) по статистике последних сделок.
    При < MIN_TRADES_FOR_KELLY — базовый риск.
    Иначе — ½-Келли в коридоре [RISK_MIN_PCT, RISK_MAX_PCT].
    """
    s = trade_stats(trades)
    if s["n"] < MIN_TRADES_FOR_KELLY:
        return RISK_BASE_PCT, f"база {RISK_BASE_PCT}% (мало данных: {s['n']} сделок)"

    if not s.get("avg_loss"):
        return RISK_MAX_PCT, "убытков нет — потолок риска"

    payoff = s["avg_win"] / s["avg_loss"]
    f_star = kelly_fraction(s["win_rate"], payoff)

    if f_star <= 0:
        return RISK_MIN_PCT, (
            f"Келли ≤ 0 (WR={s['win_rate']:.0%}, R={payoff:.2f}) → минимум"
        )

    pct = max(RISK_MIN_PCT, min(RISK_MAX_PCT, f_star * 100 * KELLY_FRACTION))
    why = (
        f"½-Келли: WR={s['win_rate']:.0%}, R={payoff:.2f}, "
        f"f*={f_star:.2%} → {pct:.2f}%"
    )
    return round(pct, 2), why


# ── Оценочный лист (fitness scorecard) ───────────────────────────────────────

def scorecard(trades: list[dict] | None = None, equity_rub: float | None = None) -> dict:
    """
    Оценочный лист за последние FITNESS_WINDOW сделок.
    Вердикт fitness: healthy / ok / weak / unproven.

    Числа объективны: их нельзя «уговорить». Консилиум смотрит на них и
    объясняет ПОЧЕМУ, но приговор выносят цифры, а не красноречие.
    """
    if trades is None:
        trades = load_closed_trades(FITNESS_WINDOW)
    window = trades[-FITNESS_WINDOW:]
    s = trade_stats(window)

    card: dict = {
        "window": FITNESS_WINDOW,
        "n": s["n"],
        "profit_factor": s.get("profit_factor"),
        "expectancy": s.get("expectancy"),
        "win_rate": s.get("win_rate"),
        "total_pnl": s.get("total_pnl"),
        "max_drawdown": s.get("max_drawdown"),
        "max_drawdown_pct": None,
    }

    if equity_rub and equity_rub > 0 and s.get("max_drawdown"):
        card["max_drawdown_pct"] = round(s["max_drawdown"] / equity_rub * 100, 2)

    n = s["n"]
    if n < max(5, FITNESS_WINDOW // 3):
        card["fitness"] = "unproven"
        card["verdict"] = f"мало сделок ({n}) — статистика недостаточна"
        return card

    pf = s.get("profit_factor")
    exp = s.get("expectancy") or 0
    dd_pct = card["max_drawdown_pct"]
    dd_breach = dd_pct is not None and dd_pct > FITNESS_MAX_DD_PCT

    if pf is None:
        card["fitness"] = "healthy" if exp > 0 else "ok"
    elif pf >= FITNESS_PF_GOOD and exp > 0 and not dd_breach:
        card["fitness"] = "healthy"
    elif pf < FITNESS_PF_BAD or exp <= 0 or dd_breach:
        card["fitness"] = "weak"
    else:
        card["fitness"] = "ok"

    parts = []
    if pf is not None:
        parts.append(f"PF={pf}")
    parts.append(f"exp={exp}₽")
    if dd_pct is not None:
        parts.append(f"просадка={dd_pct}%")
    if dd_breach:
        parts.append(f"⚠ лимит просадки {FITNESS_MAX_DD_PCT}% превышен")
    card["verdict"] = ", ".join(parts)
    return card


def scorecard_text(equity_rub: float | None = None) -> str:
    """Читаемая строка оценочного листа — для Telegram и агентов."""
    card = scorecard(equity_rub=equity_rub)
    n = card.get("n", 0)
    if n == 0:
        return "Статистики сделок пока нет (data/trades.jsonl пуст или отсутствует)."

    fitness = card.get("fitness", "?")
    icons = {"healthy": "✅", "ok": "🟡", "weak": "🔴", "unproven": "⚪"}
    icon = icons.get(fitness, "?")

    pf = card.get("profit_factor")
    wr = card.get("win_rate")
    exp = card.get("expectancy")
    pnl = card.get("total_pnl")
    dd = card.get("max_drawdown")

    parts = [
        f"{icon} Fitness: {fitness} | {n} сделок (окно {card['window']})",
        f"  WR={wr:.0%}  PF={pf if pf else 'n/a'}  exp={exp}₽/сделку",
        f"  Итого PnL: {pnl:+.0f}₽  Макс.просадка: {dd:.0f}₽",
        f"  {card.get('verdict', '')}",
    ]
    return "\n".join(parts)


def per_ticker_stats(top: int = 5) -> str:
    """Топ/антитоп тикеров по суммарному PnL — для отчёта."""
    trades = load_closed_trades(10_000)
    by_ticker: dict[str, list[float]] = {}
    for t in trades:
        tk = t.get("ticker", "?")
        by_ticker.setdefault(tk, []).append(t["pnl_rub"])

    rows = []
    for tk, pnls in by_ticker.items():
        wins = sum(1 for p in pnls if p > 0)
        rows.append((tk, sum(pnls), len(pnls), wins / len(pnls) if pnls else 0))

    rows.sort(key=lambda x: -x[1])
    if not rows:
        return "Сделок пока нет."

    lines = ["📈 По тикерам (все сделки):"]
    for tk, total, n, wr in rows[:top]:
        lines.append(f"  {tk}: {total:+.0f}₽ за {n} сделок  WR={wr:.0%}")
    if len(rows) > top:
        worst = rows[-1]
        lines.append(f"  ...худший: {worst[0]}: {worst[1]:+.0f}₽")
    return "\n".join(lines)
