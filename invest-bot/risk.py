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
     одна ставка на рынок: в группе одновременно не больше одной открытой
     позиции (независимо от направления — второй long не менее коррелирован
     с первым, чем short).
  2. РИСК ОТ УВЕРЕННОСТИ. confidence -> risk_pct (без антимартингейла —
     система не помнит прошлые сделки, только текущий сигнал).
  3. ПОРТФЕЛЬНЫЙ РИСК-ЛИМИТ. Суммарный риск всех открытых позиций ограничен
     PORTFOLIO_RISK_MAX_PCT; при перегрузке новый стоп сжимается.
  4. Стоп есть всегда и двигается только в сторону прибыли (трейлинг).
  5. Дневной стоп-лосс: минус DAILY_MAX_LOSS_PCT за день -> блокировка входов.
  6. Скользящий безубыток: 0.5R→entry, 0.75R→entry+0.25R, 1.0R→breakeven_set.
  7. Chandelier trailing + giveback-защита пика (только после breakeven_set).
  8. Не больше MAX_OPEN_POSITIONS позиций одновременно.

Состояние переживает рестарт (data/risk_state.json, data/open_positions.json).
"""
import logging
import os
import json
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone, timedelta

import math

from risk_config import (
    MAX_OPEN_POSITIONS, DAILY_MAX_LOSS_PCT, WEEKLY_MAX_LOSS_PCT, MONTHLY_MAX_LOSS_PCT,
    TRAIL_GIVEBACK_PCT, BREAKEVEN_AT_R, CHANDELIER_MULT,
    BREAKEVEN_SLIDE_START_R, BREAKEVEN_SLIDE_STEP2_R, BREAKEVEN_SLIDE_LOCK2_R,
    RISK_MIN_PCT, RISK_MID_PCT, RISK_MAX_PCT,
    CONF_LOW_THR, CONF_MID_THR, CONF_HIGH_THR,
    CORR_GROUPS, PORTFOLIO_RISK_MAX_PCT, PORTFOLIO_STOP_SQUEEZE,
    PARTIAL_TP_CLOSE_FRACTION, PARTIAL_TP_RETRACE_FRACTION,
    SCALE_OUT_EDGE_DECAY, SCALE_OUT_CLOSE_FRACTION,
    PROB_EXIT_ENABLED, PROB_EXIT_MIN_PTAKE, PROB_EXIT_GRACE_R,
    BOCD_EXIT_CONFIDENCE,
    ORDERBOOK_EXIT_ENABLED, ORDERBOOK_EXIT_THR,
    BEHAVIORAL_EXIT_VOTES_NEEDED, BEHAVIORAL_EXIT_ORDER_FLOW_THR,
    BEHAVIORAL_EXIT_HH_BARS, BEHAVIORAL_EXIT_MOMENTUM_BARS, BEHAVIORAL_EXIT_MOMENTUM_THR,
    MULTIPORT_DAILY_LOSS_PCT, MULTIPORT_WEEKLY_LOSS_PCT, MULTIPORT_MONTHLY_LOSS_PCT,
    MULTIPORT_TOTAL_RISK_MAX_PCT,
)

__all__ = ("Position", "RiskManager", "PortfolioRiskManager")


def _first_passage_prob(dist_to_stop: float, dist_to_take: float,
                          mu: float, sigma: float) -> float:
    """P(дойти до тейка раньше стопа) для дрейфующего броуновского
    движения с дрифтом mu (за бар, в пользу позиции) и волатильностью
    sigma (за бар, в тех же единицах цены). Формула гамблера-банкрота."""
    dist_to_stop = max(0.0, dist_to_stop)
    dist_to_take = max(0.0, dist_to_take)
    if dist_to_stop + dist_to_take <= 0:
        return 1.0
    if sigma <= 0:
        return 1.0 if mu >= 0 else 0.0
    if abs(mu) < 1e-12:
        return dist_to_stop / (dist_to_stop + dist_to_take)
    k = 2 * mu / (sigma * sigma)
    try:
        num = 1 - math.exp(-k * dist_to_stop)
        den = 1 - math.exp(-k * (dist_to_stop + dist_to_take))
    except OverflowError:
        return 1.0 if mu > 0 else 0.0
    if den == 0:
        return dist_to_stop / (dist_to_stop + dist_to_take)
    return max(0.0, min(1.0, num / den))

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
    risk_rub: float            # рублей на кону ПРИ ТЕКУЩЕМ стопе (пересчитывается в check_exit при трейлинге/безубытке)
    point_value: float = 1.0   # цена пункта — нужна, чтобы пересчитывать risk_rub при сдвиге stop_price
    confidence: float = 0.7    # уверенность сигнала на момент открытия (0-1)
    trail_dist: float = 0.0
    peak_profit_rub: float = 0.0
    peak_price: float = 0.0
    breakeven_set: bool = False
    adds_count: int = 0
    scaled_out: bool = False
    reasons: list = field(default_factory=list)
    take_target: float = 0.0       # уровень первого тейка из сигнала — для частичной фиксации
    half_closed: bool = False      # половина уже зафиксирована на тейке
    remainder_stop: float = 0.0    # после half_closed: фиксированный уровень защиты остатка
    fix_step: float = 0.0          # шаг для следующих фиксаций = дистанция первого плеча вход->тейк
    next_fix_level: float = 0.0    # следующий уровень цены для оценки доп. фиксации
    fix_count: int = 0             # сколько раз уже фиксировали после первого тейка
    entry_composite: float = 0.0   # сигнальный edge на момент входа (знаковый, по направлению позиции)
    initial_risk_rub: float = 0.0  # риск при открытии — не меняется при сдвиге стопа, используется для R-расчётов
    initial_trail_dist: float = 0.0  # trail_dist при открытии; нужен для восстановления после tighten
    trail_tightened: bool = False    # True после ужесточения по 1/3 поведенческих сигналов
    activation_levels: dict = field(default_factory=dict)  # per-playbook пороги: breakeven/partial/trailing (доли R)

    def pnl_rub(self, price: float, point_value: float = 1.0) -> float:
        diff = (price - self.entry_price) if self.direction == "long" \
            else (self.entry_price - price)
        return diff * self.qty * point_value


class RiskManager:
    def __init__(self, equity_getter=None):
        """equity_getter() -> float — текущий размер депо."""
        self.equity_getter = equity_getter or (lambda: 0.0)
        self.positions: dict[str, Position] = {}
        self._daily_limit: float = DAILY_MAX_LOSS_PCT
        self._weekly_limit: float = WEEKLY_MAX_LOSS_PCT
        self._monthly_limit: float = MONTHLY_MAX_LOSS_PCT
        self._build_corr_index()
        self._load_state()
        self.load_positions()

    def update_loss_limits(self, daily: float | None, weekly: float | None, monthly: float | None) -> None:
        """Вызывается из Trader после перечитки runtime_overrides."""
        if daily is not None:
            self._daily_limit = daily
        if weekly is not None:
            self._weekly_limit = weekly
        if monthly is not None:
            self._monthly_limit = monthly

    def _build_corr_index(self):
        self._ticker_group: dict[str, str] = {}
        for group, tickers in CORR_GROUPS.items():
            for t in tickers:
                self._ticker_group[t] = group

    @staticmethod
    def _week_start(d) -> str:
        return str(d - timedelta(days=d.weekday()))

    def _load_state(self):
        now = datetime.now(timezone.utc)
        today = str(now.date())
        week_start = self._week_start(now.date())
        month_ym = now.strftime("%Y-%m")
        self.state = {
            "date": today, "day_pnl_rub": 0.0, "killed": False, "trades_today": 0,
            "week_start": week_start, "week_pnl_rub": 0.0, "week_killed": False,
            "month_ym": month_ym, "month_pnl_rub": 0.0, "month_killed": False,
        }
        if os.path.exists(STATE_FILE):
            try:
                with open(STATE_FILE, encoding="utf-8") as f:
                    s = json.load(f)
                # восстанавливаем недельный/месячный аккумулятор из файла
                if s.get("week_start") == week_start:
                    self.state["week_pnl_rub"] = s.get("week_pnl_rub", 0.0)
                    self.state["week_killed"] = s.get("week_killed", False)
                if s.get("month_ym") == month_ym:
                    self.state["month_pnl_rub"] = s.get("month_pnl_rub", 0.0)
                    self.state["month_killed"] = s.get("month_killed", False)
                if s.get("date") == today:
                    self.state["day_pnl_rub"] = s.get("day_pnl_rub", 0.0)
                    self.state["killed"] = s.get("killed", False)
                    self.state["trades_today"] = s.get("trades_today", 0)
            except (json.JSONDecodeError, OSError):
                pass

    def _save_state(self):
        os.makedirs("data", exist_ok=True)
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(self.state, f, ensure_ascii=False)

    def _rollover_if_new_day(self):
        now = datetime.now(timezone.utc)
        today = str(now.date())
        if self.state.get("date") == today:
            return
        week_start = self._week_start(now.date())
        month_ym = now.strftime("%Y-%m")
        new_week = week_start != self.state.get("week_start")
        new_month = month_ym != self.state.get("month_ym")
        self.state["date"] = today
        self.state["day_pnl_rub"] = 0.0
        self.state["killed"] = False
        self.state["trades_today"] = 0
        if new_week:
            self.state["week_start"] = week_start
            self.state["week_pnl_rub"] = 0.0
            self.state["week_killed"] = False
        if new_month:
            self.state["month_ym"] = month_ym
            self.state["month_pnl_rub"] = 0.0
            self.state["month_killed"] = False
        self._save_state()
        log.info(f"risk: новый день {today} — дневной PnL сброшен"
                 + (f", новая неделя {week_start}" if new_week else "")
                 + (f", новый месяц {month_ym}" if new_month else ""))

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
            return False, f"дневной защитный стоп: лимит убытка {self._daily_limit}% достигнут"
        if self.state.get("week_killed"):
            return False, f"недельный защитный стоп: лимит убытка {self._weekly_limit}% достигнут"
        if self.state.get("month_killed"):
            return False, f"месячный защитный стоп: лимит убытка {self._monthly_limit}% достигнут"
        return True, ""

    def _register_closed_pnl(self, pnl_rub: float):
        self._rollover_if_new_day()
        self.state["day_pnl_rub"] = self.state.get("day_pnl_rub", 0.0) + pnl_rub
        self.state["week_pnl_rub"] = self.state.get("week_pnl_rub", 0.0) + pnl_rub
        self.state["month_pnl_rub"] = self.state.get("month_pnl_rub", 0.0) + pnl_rub
        self.state["trades_today"] = self.state.get("trades_today", 0) + 1
        equity = self.equity_getter() or 0
        if equity > 0:
            if not self.state.get("killed") and self.state["day_pnl_rub"] < -equity * self._daily_limit / 100:
                self.state["killed"] = True
                log.error(f"ДНЕВНОЙ ЗАЩИТНЫЙ СТОП: убыток {self.state['day_pnl_rub']:.0f}₽ "
                          f"превысил {self._daily_limit}% депо")
            if not self.state.get("week_killed") and self.state["week_pnl_rub"] < -equity * self._weekly_limit / 100:
                self.state["week_killed"] = True
                log.error(f"НЕДЕЛЬНЫЙ ЗАЩИТНЫЙ СТОП: убыток {self.state['week_pnl_rub']:.0f}₽ "
                          f"превысил {self._weekly_limit}% депо")
            if not self.state.get("month_killed") and self.state["month_pnl_rub"] < -equity * self._monthly_limit / 100:
                self.state["month_killed"] = True
                log.error(f"МЕСЯЧНЫЙ ЗАЩИТНЫЙ СТОП: убыток {self.state['month_pnl_rub']:.0f}₽ "
                          f"превысил {self._monthly_limit}% депо")
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
        # Используем initial_risk_rub (неизменный с момента открытия), а не risk_rub
        # который падает к нулю после подтягивания стопа в безубыток.
        # Это даёт консервативную оценку: портфель «занят» пока позиция открыта,
        # независимо от того, насколько стоп подтянут вперёд.
        total_risk = sum(
            (p.initial_risk_rub if p.initial_risk_rub > 0 else p.risk_rub)
            for p in self.positions.values()
        )
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
        # "Одна ставка на рынок" — это не только запрет на ПРОТИВОРЕЧАЩИЕ
        # направления внутри группы (long+short), но и запрет на ДОБАВЛЕНИЕ
        # второй позиции в ту же группу в ТОМ ЖЕ направлении: лонг SBER +
        # лонг GAZP — это не диверсификация, а удвоенная ставка на один и тот
        # же фактор риска (российский рынок акций вверх). Раньше второе
        # разрешалось — корреляционная защита фактически не работала.
        group = self._ticker_group.get(ticker)
        if group:
            tickers_in_group = [(t, p) for t, p in self.positions.items()
                                 if self._ticker_group.get(t) == group]
            if tickers_in_group:
                for t, p in tickers_in_group:
                    if p.direction == direction:
                        # Одинаковое направление — всегда блокируем (удвоение ставки)
                        return False, (
                            f"КОРРЕЛЯЦИОННЫЙ КОНФЛИКТ: группа {group} уже занята "
                            f"({p.direction.upper()} {t}), "
                            f"ещё один {direction.upper()} по {ticker} — удвоение ставки."
                        )
                    else:
                        # Противоположное направление: разрешено только при независимых горизонтах.
                        # expected_bars хранится на Position если был передан, иначе дефолт 20 баров.
                        existing_horizon = getattr(p, "expected_bars", 20) * 1  # tf неизвестен на RiskManager
                        # Без tf_minutes использовать горизонт в барах как proxy: 20 = "короткий"
                        # Если вызывается через PortfolioRiskManager — там горизонты в минутах.
                        # Здесь просто запрещаем хедж при одном RiskManager (без multi-account контекста)
                        return False, (
                            f"КОРРЕЛЯЦИОННЫЙ КОНФЛИКТ: группа {group} уже занята "
                            f"({p.direction.upper()} {t}), противоположный {direction.upper()} "
                            f"по {ticker} требует PortfolioRiskManager для проверки горизонтов."
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
                       confidence: float = 0.7,
                       take_target: float = 0.0,
                       entry_composite: float = 0.0,
                       activation_levels: dict | None = None) -> Position:
        initial_risk = abs(entry - stop) * qty * point_value
        td = trail_dist or abs(entry - stop) / 2 * CHANDELIER_MULT
        pos = Position(
            ticker=ticker, direction=direction, qty=qty,
            entry_price=entry, stop_price=stop,
            opened_ts=datetime.now().isoformat(),
            risk_rub=initial_risk,
            initial_risk_rub=initial_risk,
            point_value=point_value,
            trail_dist=td,
            initial_trail_dist=td,
            activation_levels=activation_levels or {},
            peak_price=entry,
            confidence=confidence,
            reasons=reasons or [],
            take_target=take_target,
            entry_composite=entry_composite,
        )
        self.positions[ticker] = pos
        log.info(f"OPEN {direction} {ticker} qty={qty} entry={entry} stop={stop} "
                 f"risk={pos.risk_rub:.0f}₽ conf={confidence:.0%} | "
                 f"портфель_риск={self.portfolio_risk_pct():.1f}%")
        self.save_positions()
        return pos

    def _recalc_risk_rub(self, pos: "Position") -> None:
        """
        risk_rub считался один раз при открытии и не уменьшался при подтяжке
        стопа (трейлинг/безубыток) — portfolio_risk_pct()/stop_squeeze_factor()
        видели риск как если бы стоп всегда был на первоначальном расстоянии,
        даже когда реальный риск уже ниже (или нулевой после безубытка). Раз
        stop_price сдвинулся — пересчитываем от текущей дистанции entry->stop,
        с полом в 0 (если стоп ушёл за вход — риска убытка уже нет).
        """
        if pos.direction == "long":
            dist = pos.entry_price - pos.stop_price
        else:
            dist = pos.stop_price - pos.entry_price
        pos.risk_rub = max(0.0, dist) * pos.qty * pos.point_value

    def check_exit(self, ticker: str, price: float,
                    point_value: float = 1.0,
                    squeeze: bool = False,
                    drift_per_bar: float = 0.0,
                    vol_per_bar: float = 0.0,
                    regime_confidence: float = 1.0,
                    order_flow: float = 0.0,
                    recent_highs: list[float] | None = None,
                    recent_lows: list[float] | None = None,
                    recent_opens: list[float] | None = None,
                    recent_closes: list[float] | None = None,
                    giveback_pct: float | None = None) -> tuple[bool, str]:
        """Вызывается на каждом обновлении цены. Возвращает (закрыть, причина)."""
        pos = self.positions.get(ticker)
        if not pos:
            return False, ""

        pnl = pos.pnl_rub(price, point_value)
        pos.peak_profit_rub = max(pos.peak_profit_rub, pnl)

        chandelier_moved = False
        if pos.direction == "long":
            pos.peak_price = max(pos.peak_price, price)
            if pos.trail_dist > 0:
                new_stop = max(pos.stop_price, pos.peak_price - pos.trail_dist)
                chandelier_moved = (new_stop != pos.stop_price)
                pos.stop_price = new_stop
        else:
            pos.peak_price = min(pos.peak_price, price)
            if pos.trail_dist > 0:
                new_stop = min(pos.stop_price, pos.peak_price + pos.trail_dist)
                chandelier_moved = (new_stop != pos.stop_price)
                pos.stop_price = new_stop
        if chandelier_moved:
            self._recalc_risk_rub(pos)

        # Поведенческий выход: 2 из 3 (стакан + структура + нитки).
        # Без grace-окна — нитки+тонкий стакан предшествуют гэпу.
        # При 1 из 3 условий: ужесточить chandelier (trail_dist × 0.7, один раз).
        # Если данные свечей не переданы — fallback на одиночный порог стакана.
        if recent_highs is not None and recent_lows is not None \
                and recent_opens is not None and recent_closes is not None:
            votes: dict[str, bool] = {}
            votes['order_flow'] = order_flow < BEHAVIORAL_EXIT_ORDER_FLOW_THR
            n = BEHAVIORAL_EXIT_HH_BARS
            if len(recent_highs) >= 2 * n and len(recent_lows) >= 2 * n:
                if pos.direction == "long":
                    votes['structure'] = max(recent_highs[-n:]) <= max(recent_highs[-2 * n:-n])
                else:
                    votes['structure'] = min(recent_lows[-n:]) >= min(recent_lows[-2 * n:-n])
            m = BEHAVIORAL_EXIT_MOMENTUM_BARS
            if (len(recent_opens) >= m and len(recent_closes) >= m
                    and len(recent_highs) >= m and len(recent_lows) >= m):
                avg_body = sum(abs(recent_closes[-(m - i)] - recent_opens[-(m - i)]) for i in range(m)) / m
                avg_range = sum(recent_highs[-(m - i)] - recent_lows[-(m - i)] for i in range(m)) / m
                if avg_range > 0:
                    votes['momentum_dead'] = avg_body / avg_range < BEHAVIORAL_EXIT_MOMENTUM_THR
            n_votes = sum(votes.values())
            if n_votes >= BEHAVIORAL_EXIT_VOTES_NEEDED:
                reasons_str = '+'.join(k for k, v in votes.items() if v)
                return True, (f"поведенческий выход ({reasons_str}): "
                               f"{n_votes}/{len(votes)} условий")
            # 1 из 3: предупреждение — ужесточить chandelier один раз чтобы
            # выйти быстрее если картина продолжит ухудшаться.
            if n_votes == 1 and not pos.trail_tightened and pos.initial_trail_dist > 0:
                pos.trail_dist = pos.initial_trail_dist * 0.7
                pos.trail_tightened = True
                log.debug(f"{ticker}: поведенческое предупреждение (1/3) — "
                           f"chandelier ужесточён: trail_dist × 0.7")
        elif ORDERBOOK_EXIT_ENABLED and order_flow <= ORDERBOOK_EXIT_THR:
            return True, (f"стакан: дисбаланс заявок против позиции "
                           f"({order_flow:.2f}) — выходим немедленно")

        # Остаток после частичной фиксации на тейке: фиксированный уровень
        # защиты (треть пройденного расстояния вход->тейк), независимо от
        # обычного трейлинга/стопа — проверяем отдельно, до них.
        if pos.half_closed and pos.remainder_stop:
            if pos.direction == "long" and price <= pos.remainder_stop:
                return True, f"остаток после частичной фиксации: откат к {pos.remainder_stop:.4f}"
            if pos.direction == "short" and price >= pos.remainder_stop:
                return True, f"остаток после частичной фиксации: откат к {pos.remainder_stop:.4f}"

        if pos.direction == "long" and price <= pos.stop_price:
            return True, f"стоп-лосс {pos.stop_price}"
        if pos.direction == "short" and price >= pos.stop_price:
            return True, f"стоп-лосс {pos.stop_price}"

        # Сквиз-протекция шорта: если физики в шорте и цена идёт против — выходим
        if squeeze and pos.direction == "short" and pnl < 0:
            return True, "сквиз-риск: физики в шорте, цена растёт — выходим"

        # Скользящий безубыток: три ступени с per-playbook уровнями.
        # Уровни берутся из pos.activation_levels (рассчитанных стратегией
        # из percentiles MFE для данного плейбука/режима); если не заданы —
        # используются глобальные дефолты из risk_config.
        # Chandelier работает параллельно и всегда берётся max(chandelier, ступень),
        # т.к. Chandelier пишет через max() выше, а ступени тоже через max().
        # Итого: стоп = max(chandelier_stop, breakeven_ступень) — проблема 2 закрыта.
        # breakeven_set НЕ является одноразовым замком — сбрасывается если pnl
        # опустился обратно ниже _be_start (позиция откатилась, ступени могут
        # реактивироваться при следующем росте). Стоп при этом не двигается назад
        # (max/min выше гарантируют монотонность), поэтому безубыток не «отменяется».
        ir = pos.initial_risk_rub if pos.initial_risk_rub > 0 else pos.risk_rub
        lvl = pos.activation_levels
        _be_start = lvl.get('breakeven', BREAKEVEN_SLIDE_START_R)   # дефолт 0.5R
        _be_step2 = lvl.get('partial', BREAKEVEN_SLIDE_STEP2_R)     # дефолт 0.75R
        _be_trail = lvl.get('trailing', BREAKEVEN_AT_R)             # дефолт 1.0R
        stop_moved = False
        if ir > 0:
            if pnl >= ir * _be_trail:
                if not pos.breakeven_set:
                    log.info(f"{ticker}: прибыль >= {_be_trail:.2f}R — безубыток, Chandelier+giveback активны")
                if pos.direction == "long":
                    new_stop = max(pos.stop_price, pos.entry_price)
                else:
                    new_stop = min(pos.stop_price, pos.entry_price)
                stop_moved = (new_stop != pos.stop_price)
                pos.stop_price = new_stop
                pos.breakeven_set = True
            elif pnl >= ir * _be_step2:
                # Откат из _be_trail назад — сбрасываем флаг, ступени активны снова
                pos.breakeven_set = False
                lock_dist = BREAKEVEN_SLIDE_LOCK2_R * ir / (pos.qty * pos.point_value) \
                    if pos.qty and pos.point_value else 0.0
                if pos.direction == "long":
                    new_stop = max(pos.stop_price, pos.entry_price + lock_dist)
                else:
                    new_stop = min(pos.stop_price, pos.entry_price - lock_dist)
                stop_moved = (new_stop != pos.stop_price)
                pos.stop_price = new_stop
            elif pnl >= ir * _be_start:
                pos.breakeven_set = False
                if pos.direction == "long":
                    new_stop = max(pos.stop_price, pos.entry_price)
                else:
                    new_stop = min(pos.stop_price, pos.entry_price)
                stop_moved = (new_stop != pos.stop_price)
                pos.stop_price = new_stop
            else:
                # pnl упал ниже первой ступени — сбрасываем флаг полностью
                pos.breakeven_set = False
        # Один пересчёт risk_rub за всё движение стопа на этом баре
        if stop_moved:
            self._recalc_risk_rub(pos)

        # Giveback защищает прибыль, а не фиксирует убыток — активен только
        # после того как стоп перенесён в безубыток (breakeven_set).
        if pos.breakeven_set:
            effective_giveback = giveback_pct if giveback_pct is not None else TRAIL_GIVEBACK_PCT
            giveback = pos.peak_profit_rub - pnl
            if giveback > pos.peak_profit_rub * effective_giveback / 100:
                return True, (f"трейлинг: пик +{pos.peak_profit_rub:.0f}₽, "
                               f"отдали {giveback:.0f}₽ (порог {effective_giveback:.0f}%) — фиксируем")

        # Инвалидация гипотезы входа: стоп — аварийный выключатель, а не
        # основной выход. Эти две проверки не трогают уже отработавшие
        # сделки (pnl >= grace_r * risk_rub) — там рулит Chandelier/giveback.
        grace = pos.risk_rub * PROB_EXIT_GRACE_R
        if pnl < grace:
            if (PROB_EXIT_ENABLED and pos.take_target
                    and vol_per_bar > 0):
                dist_stop = abs(price - pos.stop_price)
                dist_take = abs(pos.take_target - price)
                mu = drift_per_bar if pos.direction == "long" else -drift_per_bar
                p_take = _first_passage_prob(dist_stop, dist_take, mu, vol_per_bar)
                if p_take < PROB_EXIT_MIN_PTAKE:
                    return True, (f"вероятность дойти до тейка упала до {p_take:.0%} "
                                   f"(дрифт против движения) — закрываем")

            if regime_confidence < BOCD_EXIT_CONFIDENCE:
                return True, (f"смена режима рынка (BOCD): confidence={regime_confidence:.0%} "
                               f"— гипотеза входа сломана")

        return False, ""

    def check_partial_take(self, ticker: str, price: float) -> tuple[bool, int, float]:
        """
        Возвращает (зафиксировать половину, qty к закрытию, уровень защиты
        остатка). Срабатывает один раз — при первом достижении take_target
        после открытия (half_closed=False). qtyـto_close = PARTIAL_TP_CLOSE_FRACTION
        от текущего объёма (минимум 1 лот) — округление вниз, остаток не
        обязан делиться на 2 без остатка.
        """
        pos = self.positions.get(ticker)
        if not pos or pos.half_closed or pos.take_target <= 0 or pos.qty < 2:
            return False, 0, 0.0
        reached = (pos.direction == "long" and price >= pos.take_target) or \
                  (pos.direction == "short" and price <= pos.take_target)
        if not reached:
            return False, 0, 0.0
        dist = abs(pos.take_target - pos.entry_price)
        retrace = dist * PARTIAL_TP_RETRACE_FRACTION
        remainder_stop = pos.take_target - retrace if pos.direction == "long" else pos.take_target + retrace
        qty_to_close = max(1, int(pos.qty * PARTIAL_TP_CLOSE_FRACTION))
        qty_to_close = min(qty_to_close, pos.qty - 1)  # хотя бы 1 лот остаётся
        return True, qty_to_close, remainder_stop

    def check_scale_out(self, ticker: str, price: float, current_edge: float) -> tuple[bool, int, float]:
        """
        Вызывается после half_closed=True, на каждом обновлении цены —
        оценивает, не пора ли зафиксировать ещё часть остатка. Срабатывает
        только при достижении очередного шага next_fix_level (тот же шаг,
        что и первое плечо вход->тейк). current_edge — знаковый edge сигнала
        (composite по направлению позиции: +composite для long, -composite
        для short) на текущий момент.

        Если edge просел ниже entry_composite * SCALE_OUT_EDGE_DECAY —
        преимущество исчезает, фиксируем ещё SCALE_OUT_CLOSE_FRACTION остатка.
        Иначе сигнал всё ещё в силе — просто подтягиваем remainder_stop
        вперёд (никогда не отпускаем назад) и сдвигаем следующий шаг.

        Возвращает (зафиксировать ли доп.часть, qty к закрытию, новый
        remainder_stop). remainder_stop в результате актуален всегда —
        даже если зафиксировать не пришлось (для информирования вызывающей
        стороны), но при price-движении мутирует pos.remainder_stop в любом
        случае как побочный эффект.
        """
        pos = self.positions.get(ticker)
        if not pos or not pos.half_closed or pos.fix_step <= 0 or pos.qty < 2:
            return False, 0, 0.0
        reached = (pos.direction == "long" and price >= pos.next_fix_level) or \
                  (pos.direction == "short" and price <= pos.next_fix_level)
        if not reached:
            return False, 0, 0.0

        retrace = pos.fix_step * PARTIAL_TP_RETRACE_FRACTION
        candidate_stop = price - retrace if pos.direction == "long" else price + retrace
        # Вычисляем новый remainder_stop до решения о фиксации, но применяем
        # мутацию только один раз: сначала edge-проверка, потом — обновление стопа.
        # Это предотвращает ситуацию когда стоп уже сдвинулся, а закрытия не было.
        new_remainder_stop = (max(pos.remainder_stop, candidate_stop)
                              if pos.direction == "long"
                              else min(pos.remainder_stop, candidate_stop))

        decayed = current_edge < pos.entry_composite * SCALE_OUT_EDGE_DECAY
        if not decayed:
            # Edge жив — просто подтягиваем стоп и сдвигаем уровень следующего шага
            pos.remainder_stop = new_remainder_stop
            pos.next_fix_level += pos.fix_step if pos.direction == "long" else -pos.fix_step
            return False, 0, pos.remainder_stop

        # Edge исчез — фиксируем, обновляем состояние
        pos.remainder_stop = new_remainder_stop
        pos.next_fix_level += pos.fix_step if pos.direction == "long" else -pos.fix_step
        qty_to_close = max(1, int(pos.qty * SCALE_OUT_CLOSE_FRACTION))
        qty_to_close = min(qty_to_close, pos.qty - 1)  # хотя бы 1 лот остаётся
        pos.fix_count += 1
        return True, qty_to_close, pos.remainder_stop

    def reduce_position(self, ticker: str, qty: int, price: float,
                         point_value: float = 1.0, reason: str = "",
                         remainder_stop: float = 0.0) -> dict | None:
        pos = self.positions.get(ticker)
        if not pos or qty <= 0:
            return None
        qty = min(qty, pos.qty)
        diff = (price - pos.entry_price) if pos.direction == "long" \
            else (pos.entry_price - price)
        pnl = diff * qty * point_value
        pos.qty -= qty
        pos.risk_rub = max(0.0, pos.risk_rub * (pos.qty / (pos.qty + qty)))
        if remainder_stop:
            if not pos.half_closed:
                # первая частичная фиксация на тейке — задаём шаг для
                # последующих фиксаций (та же дистанция вход->тейк) и
                # уровень, на котором будем оценивать следующий шаг.
                pos.fix_step = abs(pos.take_target - pos.entry_price)
                pos.next_fix_level = (pos.take_target + pos.fix_step) if pos.direction == "long" \
                    else (pos.take_target - pos.fix_step)
                pos.fix_count += 1
            pos.half_closed = True
            pos.remainder_stop = remainder_stop
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
        add_risk = abs(price - pos.stop_price) * qty * point_value
        pos.risk_rub += add_risk
        # initial_risk_rub растёт вместе с позицией — иначе скользящий безубыток
        # защищает только первоначальный транш, а добавленный остаётся незащищённым.
        pos.initial_risk_rub += add_risk
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
            "week_pnl_rub": round(self.state.get("week_pnl_rub", 0), 2),
            "month_pnl_rub": round(self.state.get("month_pnl_rub", 0), 2),
            "trades_today": self.state.get("trades_today", 0),
            "day_stop_active": self.state.get("killed", False),
            "week_stop_active": self.state.get("week_killed", False),
            "month_stop_active": self.state.get("month_killed", False),
            "daily_limit_pct": self._daily_limit,
            "weekly_limit_pct": self._weekly_limit,
            "monthly_limit_pct": self._monthly_limit,
            "portfolio_risk_pct": port_risk,
            "squeeze_factor": squeeze,
            "group_directions": group_dirs,
        }


class PortfolioRiskManager:
    """
    Мульти-счётный риск-менеджер для multi-account торговли.

    Принимает список TradingSystem (из trading_system.py). Каждый счёт имеет
    свой RiskManager, таймфрейм и плейбуки, но лимиты убытка и суммарный риск
    проверяются ЕДИНЫМ образом по всем счетам.

    Ключевые правила:
      - Дневной/недельный/месячный лимит: суммарно по всем счетам.
      - Суммарный открытый риск ≤ MULTIPORT_TOTAL_RISK_MAX_PCT.
      - Корреляционная группа занята в том же направлении = доп.риск суммируется.
      - Противоположные позиции разрешены только если горизонты не перекрываются.
      - При достижении лимита входы блокируются; открытые позиции НЕ трогаются.
      - stat_break на любом счёте — блокирует входы на всех.

    Использование:
        from trading_system import TradingSystem, Signal
        pf = PortfolioRiskManager([sys_a, sys_b])
        ok, why = pf.can_enter(signal)
        entered = pf.sort_and_filter([sig_a, sig_b])   # расставляет приоритеты
    """

    HORIZON_OVERLAP_MAX = 0.30   # >30% перекрытия горизонтов → не независимые

    def __init__(self, accounts: list):
        # accounts — список TradingSystem (typing: list["TradingSystem"])
        self.accounts = accounts

    # ── Агрегаты по всем счетам ──────────────────────────────────────────────

    def total_equity(self) -> float:
        return sum(a.equity for a in self.accounts)

    def total_day_pnl_rub(self) -> float:
        return sum(a.daily_pnl_rub for a in self.accounts)

    def total_week_pnl_rub(self) -> float:
        return sum(a.week_pnl_rub for a in self.accounts)

    def total_month_pnl_rub(self) -> float:
        return sum(a.month_pnl_rub for a in self.accounts)

    def total_open_risk_rub(self) -> float:
        return sum(a.current_risk_rub for a in self.accounts)

    def daily_limit_hit(self) -> bool:
        eq = self.total_equity()
        return eq > 0 and self.total_day_pnl_rub() <= -eq * MULTIPORT_DAILY_LOSS_PCT / 100

    def stat_break_active(self) -> bool:
        """True если stat_break сработал на ЛЮБОМ счёте — блокирует все входы."""
        for a in self.accounts:
            strat = getattr(a, "strategy", None)
            if strat and getattr(strat, "stat_break_quarantine_active", False):
                return True
        return False

    # ── Корреляция между счетами ─────────────────────────────────────────────

    def _correlated_tickers(self, ticker_a: str, ticker_b: str) -> bool:
        """True если тикеры в одной корреляционной группе CORR_GROUPS."""
        from risk_config import CORR_GROUPS
        for group in CORR_GROUPS.values():
            if ticker_a in group and ticker_b in group:
                return True
        return False

    @staticmethod
    def horizons_independent(horizon_new_min: float, horizon_existing_min: float) -> bool:
        """True если горизонты сделок достаточно различаются (overlap < 30%)."""
        hi = max(horizon_new_min, horizon_existing_min)
        if hi <= 0:
            return False
        lo = min(horizon_new_min, horizon_existing_min)
        return lo / hi < PortfolioRiskManager.HORIZON_OVERLAP_MAX

    # ── Основная проверка входа ──────────────────────────────────────────────

    def can_enter(self, signal) -> tuple[bool, str]:
        """
        Проверить, разрешён ли вход signal (Signal из trading_system.py)
        по суммарным портфельным лимитам.

        Порядок проверок:
          1. Дневной / недельный / месячный лимит
          2. Суммарный открытый риск (с учётом новой позиции)
          3. Stat_break на любом счёте
          4. Корреляционная группа: одинаковое направление = доп.проверка риска
          5. Противоположная позиция: только если горизонты независимы
        """
        eq = self.total_equity()
        if eq <= 0:
            return True, ""

        # 1. Временны́е лимиты убытка
        if self.daily_limit_hit():
            pct = self.total_day_pnl_rub() / eq * 100
            return False, (f"портфельный дневной лимит: суммарный убыток {pct:.2f}% "
                            f"≤ -{MULTIPORT_DAILY_LOSS_PCT}% — входы заблокированы")

        week_pct = self.total_week_pnl_rub() / eq * 100
        if week_pct <= -MULTIPORT_WEEKLY_LOSS_PCT:
            return False, f"портфельный недельный лимит: {week_pct:.2f}% ≤ -{MULTIPORT_WEEKLY_LOSS_PCT}%"

        month_pct = self.total_month_pnl_rub() / eq * 100
        if month_pct <= -MULTIPORT_MONTHLY_LOSS_PCT:
            return False, f"портфельный месячный лимит: {month_pct:.2f}% ≤ -{MULTIPORT_MONTHLY_LOSS_PCT}%"

        # 2. Суммарный риск с учётом новой позиции
        total_risk_pct = (self.total_open_risk_rub() + signal.risk_rub) / eq * 100
        if total_risk_pct > MULTIPORT_TOTAL_RISK_MAX_PCT:
            return False, (f"суммарный открытый риск {total_risk_pct:.2f}% "
                            f"> лимита {MULTIPORT_TOTAL_RISK_MAX_PCT}%")

        # 3. Stat_break
        if self.stat_break_active():
            return False, "stat_break активен — входы заблокированы на всех счетах"

        # 4–5. Кросс-счётные позиции
        extra_risk = 0.0
        for a in self.accounts:
            for ticker, pos in a.open_positions.items():
                if not self._correlated_tickers(ticker, signal.ticker):
                    continue
                if pos.direction == signal.direction:
                    # Одинаковое направление — риск суммируется, повторная проверка
                    extra_risk += pos.risk_rub
                else:
                    # Противоположная позиция: разрешена только при независимых горизонтах
                    pos_horizon = getattr(pos, "expected_bars", 20) * a.tf_minutes
                    if not self.horizons_independent(signal.horizon_minutes, pos_horizon):
                        return False, (
                            f"противоположная позиция {ticker} (tf={a.tf_minutes}m): "
                            f"горизонты перекрываются > {self.HORIZON_OVERLAP_MAX:.0%} — "
                            f"вход запрещён (риск гэпа по обоим стопам)"
                        )

        if extra_risk > 0:
            corr_risk_pct = (self.total_open_risk_rub() + signal.risk_rub + extra_risk) / eq * 100
            if corr_risk_pct > MULTIPORT_TOTAL_RISK_MAX_PCT:
                return False, (
                    f"скоррелированные позиции: суммарный риск с учётом "
                    f"дублирующегося направления {corr_risk_pct:.2f}% > лимита"
                )

        return True, f"портфель OK: риск {total_risk_pct:.2f}% / {MULTIPORT_TOTAL_RISK_MAX_PCT}%"

    # ── Приоритизация одновременных сигналов ─────────────────────────────────

    @staticmethod
    def entry_priority(signal) -> float:
        """confidence × log(горизонт в минутах) — чем выше, тем раньше входим."""
        import math
        h = max(1.0, signal.horizon_minutes)
        return signal.confidence * math.log(h)

    def sort_and_filter(self, signals: list) -> list:
        """
        Принимает список Signal, сортирует по приоритету, пропускает через
        can_enter — возвращает только те, которые разрешены риск-менеджером.
        Каждый сигнал проверяется с учётом уже разрешённых ранее в очереди.
        """
        ordered = sorted(signals, key=self.entry_priority, reverse=True)
        approved = []
        for sig in ordered:
            ok, why = self.can_enter(sig)
            if ok:
                approved.append(sig)
                # Эмулируем добавление риска для следующих проверок в этом батче,
                # чтобы второй сигнал не проходил если суммарный риск уже исчерпан.
                # Мутировать state не хотим — используем временную заглушку.
                _placeholder = _RiskPlaceholder(sig.risk_rub)
                for a in self.accounts:
                    if a is sig.account:
                        a.rm.positions.setdefault(f"__pending_{sig.ticker}", _placeholder)
                        break
        # Убираем временные заглушки
        for a in self.accounts:
            pending = [k for k in a.rm.positions if k.startswith("__pending_")]
            for k in pending:
                del a.rm.positions[k]
        return approved

    # ── Статус ───────────────────────────────────────────────────────────────

    def status(self) -> dict:
        eq = self.total_equity()
        return {
            "total_equity": round(eq, 2),
            "total_day_pnl_rub": round(self.total_day_pnl_rub(), 2),
            "total_week_pnl_rub": round(self.total_week_pnl_rub(), 2),
            "total_month_pnl_rub": round(self.total_month_pnl_rub(), 2),
            "total_open_risk_rub": round(self.total_open_risk_rub(), 2),
            "total_open_risk_pct": round(self.total_open_risk_rub() / eq * 100, 2) if eq > 0 else 0.0,
            "daily_limit_hit": self.daily_limit_hit(),
            "stat_break_active": self.stat_break_active(),
            "accounts": len(self.accounts),
        }


class _RiskPlaceholder:
    """Временная заглушка позиции для учёта pending-риска в sort_and_filter."""
    def __init__(self, risk_rub: float):
        self.risk_rub = risk_rub
