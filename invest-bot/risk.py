"""
risk.py — риск-менеджер. Слой дисциплины перед открытием/добором позиций.

Перенесено из risk.html (внешняя спецификация) и адаптировано под invest-bot:
  - "logger.py"/"metrics" модулей в проекте нет -> обычный logging.getLogger.
  - "config.py" с глобальными константами в проекте нет (тут settings.ini +
    dataclass'ы per-strategy) -> константы вынесены в risk_config.py.
  - ticker в can_open/open_position — это strategy.settings.ticker
    (человеческий тикер, "SBER"), не FIGI: CORR_GROUPS заданы тикерами.

Правила:
  1. КОРРЕЛЯЦИОННЫЙ РИСК. Все тикеры в одной группе risk_config.CORR_GROUPS —
     одна ставка на рынок. В группе одновременно только одно направление.
  2. РИСК ОТ УВЕРЕННОСТИ. confidence -> risk_pct (без антимартингейла —
     система не помнит прошлые сделки, только текущий сигнал).
  3. ПОРТФЕЛЬНЫЙ РИСК-ЛИМИТ. Суммарный риск всех открытых позиций ограничен
     PORTFOLIO_RISK_MAX_PCT; при перегрузке новый стоп сжимается.
  4. Стоп есть всегда и двигается только в сторону прибыли (трейлинг).
  5. Дневной стоп-лосс: минус DAILY_MAX_LOSS_PCT за день -> блокировка входов.
  6. После 1R прибыли -> стоп в безубыток.
  7. Трейлинг Chandelier + giveback-защита пика.
  8. Не больше MAX_OPEN_POSITIONS позиций одновременно.

Состояние переживает рестарт (data/risk_state.json, data/open_positions.json).
"""
import logging
import os
import json
from dataclasses import dataclass, field, asdict
from datetime import datetime, date

from risk_config import (
    MAX_OPEN_POSITIONS, DAILY_MAX_LOSS_PCT,
    TRAIL_GIVEBACK_PCT, BREAKEVEN_AT_R, CHANDELIER_MULT,
    RISK_MIN_PCT, RISK_MID_PCT, RISK_MAX_PCT,
    CONF_LOW_THR, CONF_MID_THR, CONF_HIGH_THR,
    CORR_GROUPS, PORTFOLIO_RISK_MAX_PCT, PORTFOLIO_STOP_SQUEEZE,
)

__all__ = ("Position", "RiskManager")

log = logging.getLogger(__name__)

STATE_FILE = "data/risk_state.json"
POSITIONS_FILE = "data/open_positions.json"


@dataclass
class Position:
    ticker: str
    direction: str            # "long" | "short"
    qty: int
    entry_price: float
    stop_price: float
    opened_ts: str
    risk_rub: float            # рублей на кону при стопе
    confidence: float = 0.7    # уверенность сигнала на момент открытия (0-1)
    trail_dist: float = 0.0
    peak_profit_rub: float = 0.0
    peak_price: float = 0.0
    breakeven_set: bool = False
    adds_count: int = 0
    scaled_out: bool = False
    reasons: list = field(default_factory=list)

    def pnl_rub(self, price: float, point_value: float = 1.0) -> float:
        diff = (price - self.entry_price) if self.direction == "long" \
            else (self.entry_price - price)
        return diff * self.qty * point_value


class RiskManager:
    def __init__(self, equity_getter=None):
        """equity_getter() -> float — текущий размер депо."""
        self.equity_getter = equity_getter or (lambda: 0.0)
        self.positions: dict[str, Position] = {}
        self._build_corr_index()
        self._load_state()
        self.load_positions()

    def _build_corr_index(self):
        self._ticker_group: dict[str, str] = {}
        for group, tickers in CORR_GROUPS.items():
            for t in tickers:
                self._ticker_group[t] = group

    def _load_state(self):
        today = str(date.today())
        self.state = {"date": today, "day_pnl_rub": 0.0,
                      "killed": False, "trades_today": 0}
        if os.path.exists(STATE_FILE):
            try:
                with open(STATE_FILE, encoding="utf-8") as f:
                    s = json.load(f)
                if s.get("date") == today:
                    self.state = s
            except (json.JSONDecodeError, OSError):
                pass

    def _save_state(self):
        os.makedirs("data", exist_ok=True)
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(self.state, f, ensure_ascii=False)

    def _rollover_if_new_day(self):
        today = str(date.today())
        if self.state.get("date") == today:
            return
        self.state = {"date": today, "day_pnl_rub": 0.0,
                      "killed": False, "trades_today": 0}
        self._save_state()
        log.info(f"risk: новый день {today} — PnL и дневной защитный стоп сброшены")

    # ── Персистентность позиций ─────────────────────────────────────────────

    def save_positions(self):
        os.makedirs("data", exist_ok=True)
        try:
            data = {"saved_ts": datetime.now().isoformat(),
                    "positions": {t: asdict(p) for t, p in self.positions.items()}}
            tmp = POSITIONS_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp, POSITIONS_FILE)
        except Exception as e:
            log.warning(f"save_positions: {e}")

    def load_positions(self) -> dict:
        if not os.path.exists(POSITIONS_FILE):
            return {}
        try:
            with open(POSITIONS_FILE, encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            log.warning(f"load_positions: {e}")
            return {}
        restored = data.get("positions", {})
        for ticker, pd in restored.items():
            if ticker in self.positions:
                continue
            try:
                self.positions[ticker] = Position(**pd)
            except (TypeError, ValueError) as e:
                log.warning(f"load_positions: {ticker} повреждена: {e}")
        if restored:
            log.info(f"восстановлено {len(restored)} позиций: {list(restored.keys())}")
        return restored

    # ── Дневной защитный стоп ────────────────────────────────────────────────

    def trading_allowed(self) -> tuple[bool, str]:
        self._rollover_if_new_day()
        if self.state.get("killed"):
            return False, f"дневной защитный стоп: лимит убытка {DAILY_MAX_LOSS_PCT}% достигнут"
        return True, ""

    def _register_closed_pnl(self, pnl_rub: float):
        self._rollover_if_new_day()
        self.state["day_pnl_rub"] = self.state.get("day_pnl_rub", 0.0) + pnl_rub
        self.state["trades_today"] = self.state.get("trades_today", 0) + 1
        equity = self.equity_getter() or 0
        if equity > 0 and self.state["day_pnl_rub"] < -equity * DAILY_MAX_LOSS_PCT / 100:
            self.state["killed"] = True
            log.error(f"ДНЕВНОЙ ЗАЩИТНЫЙ СТОП: убыток {self.state['day_pnl_rub']:.0f}₽ "
                      f"превысил {DAILY_MAX_LOSS_PCT}% депо")
        self._save_state()

    # ── Корреляционный риск ──────────────────────────────────────────────────

    def group_direction(self, group: str) -> str | None:
        """Текущее направление группы: "long", "short" или None."""
        dirs = [p.direction for t, p in self.positions.items()
                if self._ticker_group.get(t) == group]
        if not dirs:
            return None
        if len(set(dirs)) > 1:
            log.warning(f"CORR: группа {group} содержит СМЕШАННЫЕ направления {dirs}!")
        return max(set(dirs), key=dirs.count)

    def portfolio_risk_pct(self) -> float:
        equity = self.equity_getter() or 0
        if equity <= 0:
            return 0.0
        total_risk = sum(p.risk_rub for p in self.positions.values())
        return round(total_risk / equity * 100, 2)

    def stop_squeeze_factor(self) -> float:
        """
        squeeze_factor = 1.0 -> стоп нормальный (портфель свободен)
        squeeze_factor = 0.0 -> нет места для нового риска вообще
        """
        if not PORTFOLIO_STOP_SQUEEZE:
            return 1.0
        current = self.portfolio_risk_pct()
        if current >= PORTFOLIO_RISK_MAX_PCT:
            return 0.0
        factor = (PORTFOLIO_RISK_MAX_PCT - current) / PORTFOLIO_RISK_MAX_PCT
        return round(max(0.0, min(1.0, factor)), 3)

    # ── Риск от уверенности (без антимартингейла) ────────────────────────────

    def risk_pct_from_confidence(self, confidence: float) -> tuple[float, str]:
        if confidence < CONF_LOW_THR:
            return 0.0, f"уверенность {confidence:.0%} < порога {CONF_LOW_THR:.0%} — вход запрещён"
        elif confidence < CONF_MID_THR:
            return RISK_MIN_PCT, f"слабый сигнал {confidence:.0%} -> {RISK_MIN_PCT}% (узкий стоп, цель 1R)"
        elif confidence < CONF_HIGH_THR:
            return RISK_MID_PCT, f"средний сигнал {confidence:.0%} -> {RISK_MID_PCT}% (средний стоп, цель 2R)"
        else:
            return RISK_MAX_PCT, f"сильный сигнал {confidence:.0%} -> {RISK_MAX_PCT}% (широкий стоп, цель 3-5R)"

    def current_risk_pct(self, confidence: float = 0.7) -> tuple[float, str]:
        return self.risk_pct_from_confidence(confidence)

    # ── Допуск к входу ────────────────────────────────────────────────────────

    def can_open(self, ticker: str, direction: str, confidence: float = 0.7) -> tuple[bool, str]:
        ok, why = self.trading_allowed()
        if not ok:
            return False, why

        if len(self.positions) >= MAX_OPEN_POSITIONS:
            return False, f"уже {MAX_OPEN_POSITIONS} позиций — лимит"

        if ticker in self.positions:
            return False, "позиция уже открыта — это добор, см. can_add()"

        # ── Корреляционный риск ────────────────────────────────────────────
        group = self._ticker_group.get(ticker)
        if group:
            group_dir = self.group_direction(group)
            if group_dir and group_dir != direction:
                tickers_in_group = [t for t, p in self.positions.items()
                                    if self._ticker_group.get(t) == group]
                return False, (
                    f"КОРРЕЛЯЦИОННЫЙ КОНФЛИКТ: группа {group} уже в {group_dir.upper()}, "
                    f"новый {direction.upper()} по {ticker} запрещён. "
                    f"Активные позиции группы: {tickers_in_group}"
                )

        # ── Уверенность в сигнале ──────────────────────────────────────────
        risk_pct, risk_why = self.risk_pct_from_confidence(confidence)
        if risk_pct == 0.0:
            return False, risk_why

        # ── Портфельный риск ───────────────────────────────────────────────
        squeeze = self.stop_squeeze_factor()
        if squeeze == 0.0:
            port_risk = self.portfolio_risk_pct()
            return False, (
                f"ПОРТФЕЛЬ ПЕРЕГРУЖЕН: суммарный риск {port_risk:.1f}% "
                f">= лимита {PORTFOLIO_RISK_MAX_PCT}% — новый вход запрещён"
            )

        return True, f"{risk_why} | squeeze={squeeze:.2f}"

    def can_add(self, ticker: str, direction: str, add_risk_rub: float,
                new_confidence: float,
                max_adds: int = 2, risk_budget_r: float = 2.0) -> tuple[bool, str]:
        """
        Добор разрешён только если new_confidence выше уверенности при открытии —
        добор из соображений "сейчас выгодно" запрещён.
        """
        ok, why = self.trading_allowed()
        if not ok:
            return False, why
        pos = self.positions.get(ticker)
        if not pos:
            return False, "нет позиции — это не добор"
        if pos.direction != direction:
            return False, "направление не совпадает — сначала закрыть"
        if pos.adds_count >= max_adds:
            return False, f"лимит доборов {max_adds} исчерпан"

        if new_confidence <= pos.confidence:
            return False, (
                f"добор запрещён: уверенность {new_confidence:.0%} не выше "
                f"уверенности при открытии {pos.confidence:.0%}. "
                "Добор допустим только при усилении сигнала."
            )

        equity = self.equity_getter() or 0
        pct, _ = self.risk_pct_from_confidence(pos.confidence)
        budget = equity * pct / 100 * risk_budget_r
        if pos.risk_rub + add_risk_rub > budget:
            return False, (
                f"бюджет риска позиции {budget:.0f}₽ "
                f"(сейчас {pos.risk_rub:.0f}₽ + добор {add_risk_rub:.0f}₽)"
            )
        return True, f"сигнал усилился: {pos.confidence:.0%} -> {new_confidence:.0%}"

    # ── Размер позиции ────────────────────────────────────────────────────────

    def position_size(self, entry: float, stop: float,
                       point_value: float = 1.0, lot: int = 1,
                       confidence: float = 0.7,
                       vol_adj: float = 1.0) -> tuple[int, str]:
        equity = self.equity_getter() or 0
        stop_dist = abs(entry - stop)
        if equity <= 0 or stop_dist <= 0 or point_value <= 0:
            return 0, "нет данных для расчёта"

        pct, conf_why = self.risk_pct_from_confidence(confidence)
        if pct == 0.0:
            return 0, conf_why

        squeeze = self.stop_squeeze_factor()
        effective_pct = pct * squeeze * vol_adj
        risk_rub = equity * effective_pct / 100
        qty = int(risk_rub / (stop_dist * point_value))
        qty = max(0, (qty // lot) * lot)

        why = (f"{conf_why} | портфель squeeze={squeeze:.2f} vol={vol_adj:.2f} "
               f"-> эфф.риск={effective_pct:.2f}% ({risk_rub:.0f}₽) -> {qty} лотов")
        log.debug(why)
        return qty, why

    # ── Открытие / жизнь / закрытие позиции ─────────────────────────────────

    def open_position(self, ticker: str, direction: str, qty: int,
                       entry: float, stop: float, point_value: float = 1.0,
                       reasons: list | None = None,
                       trail_dist: float = 0.0,
                       confidence: float = 0.7) -> Position:
        pos = Position(
            ticker=ticker, direction=direction, qty=qty,
            entry_price=entry, stop_price=stop,
            opened_ts=datetime.now().isoformat(),
            risk_rub=abs(entry - stop) * qty * point_value,
            trail_dist=trail_dist or abs(entry - stop) / 2 * CHANDELIER_MULT,
            peak_price=entry,
            confidence=confidence,
            reasons=reasons or [],
        )
        self.positions[ticker] = pos
        log.info(f"OPEN {direction} {ticker} qty={qty} entry={entry} stop={stop} "
                 f"risk={pos.risk_rub:.0f}₽ conf={confidence:.0%} | "
                 f"портфель_риск={self.portfolio_risk_pct():.1f}%")
        self.save_positions()
        return pos

    def check_exit(self, ticker: str, price: float,
                    point_value: float = 1.0,
                    squeeze: bool = False) -> tuple[bool, str]:
        """Вызывается на каждом обновлении цены. Возвращает (закрыть, причина)."""
        pos = self.positions.get(ticker)
        if not pos:
            return False, ""

        pnl = pos.pnl_rub(price, point_value)
        pos.peak_profit_rub = max(pos.peak_profit_rub, pnl)

        if pos.direction == "long":
            pos.peak_price = max(pos.peak_price, price)
            if pos.trail_dist > 0:
                pos.stop_price = max(pos.stop_price, pos.peak_price - pos.trail_dist)
        else:
            pos.peak_price = min(pos.peak_price, price)
            if pos.trail_dist > 0:
                pos.stop_price = min(pos.stop_price, pos.peak_price + pos.trail_dist)

        if pos.direction == "long" and price <= pos.stop_price:
            return True, f"стоп-лосс {pos.stop_price}"
        if pos.direction == "short" and price >= pos.stop_price:
            return True, f"стоп-лосс {pos.stop_price}"

        # Сквиз-протекция шорта: если физики в шорте и цена идёт против — выходим
        if squeeze and pos.direction == "short" and pnl < 0:
            return True, "сквиз-риск: физики в шорте, цена растёт — выходим"

        if not pos.breakeven_set and pnl >= pos.risk_rub * BREAKEVEN_AT_R:
            if pos.direction == "long":
                pos.stop_price = max(pos.stop_price, pos.entry_price)
            else:
                pos.stop_price = min(pos.stop_price, pos.entry_price)
            pos.breakeven_set = True
            log.info(f"{ticker}: прибыль >= {BREAKEVEN_AT_R}R — стоп в безубыток")

        if pos.peak_profit_rub > pos.risk_rub:
            giveback = pos.peak_profit_rub - pnl
            if giveback > pos.peak_profit_rub * TRAIL_GIVEBACK_PCT / 100:
                return True, (f"трейлинг: пик +{pos.peak_profit_rub:.0f}₽, "
                               f"отдали {giveback:.0f}₽ — фиксируем")
        return False, ""

    def reduce_position(self, ticker: str, qty: int, price: float,
                         point_value: float = 1.0, reason: str = "") -> dict | None:
        pos = self.positions.get(ticker)
        if not pos or qty <= 0:
            return None
        qty = min(qty, pos.qty)
        diff = (price - pos.entry_price) if pos.direction == "long" \
            else (pos.entry_price - price)
        pnl = diff * qty * point_value
        pos.qty -= qty
        pos.risk_rub = max(0.0, pos.risk_rub * (pos.qty / (pos.qty + qty)))
        self._register_closed_pnl(pnl)
        result = {"ticker": ticker, "direction": pos.direction, "qty": qty,
                  "entry": round(pos.entry_price, 2), "exit": price,
                  "pnl_rub": round(pnl, 2), "partial": True,
                  "left_qty": pos.qty, "reason": reason,
                  "closed_ts": datetime.now().isoformat()}
        log.info(f"REDUCE {ticker} -{qty} @ {price} pnl={pnl:+.0f}₽ (осталось {pos.qty})")
        if pos.qty == 0:
            self.positions.pop(ticker, None)
        self.save_positions()
        return result

    def add_to_position(self, ticker: str, qty: int, price: float,
                         point_value: float = 1.0) -> None:
        pos = self.positions.get(ticker)
        if not pos or qty <= 0:
            return
        total = pos.qty + qty
        pos.entry_price = (pos.entry_price * pos.qty + price * qty) / total
        pos.qty = total
        pos.risk_rub += abs(price - pos.stop_price) * qty * point_value
        pos.adds_count += 1
        pos.scaled_out = False
        log.info(f"ADD {ticker} +{qty} @ {price} -> qty={total}, "
                 f"avg={pos.entry_price:.2f}, риск={pos.risk_rub:.0f}₽")
        self.save_positions()

    def close_position(self, ticker: str, price: float,
                        point_value: float = 1.0, reason: str = "") -> dict | None:
        pos = self.positions.pop(ticker, None)
        if not pos:
            return None
        pnl = pos.pnl_rub(price, point_value)
        self._register_closed_pnl(pnl)
        result = {
            "ticker": ticker, "direction": pos.direction, "qty": pos.qty,
            "entry": pos.entry_price, "exit": price,
            "pnl_rub": round(pnl, 2),
            "peak_profit_rub": round(pos.peak_profit_rub, 2),
            "opened_ts": pos.opened_ts, "closed_ts": datetime.now().isoformat(),
            "reason": reason, "entry_reasons": pos.reasons,
            "confidence": pos.confidence,
        }
        log.info(f"CLOSE {ticker} {pos.direction} pnl={pnl:+.0f}₽ | {reason} | "
                 f"портфель_риск={self.portfolio_risk_pct():.1f}%")
        self.save_positions()
        return result

    # ── Статус ────────────────────────────────────────────────────────────────

    def status(self) -> dict:
        ok, why = self.trading_allowed()
        port_risk = self.portfolio_risk_pct()
        squeeze = self.stop_squeeze_factor()

        group_dirs = {}
        for group in CORR_GROUPS:
            d = self.group_direction(group)
            if d:
                group_dirs[group] = d

        return {
            "trading_allowed": ok,
            "block_reason": why,
            "open_positions": len(self.positions),
            "day_pnl_rub": round(self.state.get("day_pnl_rub", 0), 2),
            "trades_today": self.state.get("trades_today", 0),
            "day_stop_active": self.state.get("killed", False),
            "portfolio_risk_pct": port_risk,
            "squeeze_factor": squeeze,
            "group_directions": group_dirs,
        }
