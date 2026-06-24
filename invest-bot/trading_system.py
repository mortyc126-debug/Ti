"""
trading_system.py — тонкая обёртка над OICompositeStrategy для multi-account.

TradingSystem связывает:
  - экземпляр стратегии (OICompositeStrategy)
  - экземпляр RiskManager (один счёт)
  - таймфрейм в минутах
  - разрешённые плейбуки
  - ссылку на SharedICEWAStore (общее обучение весов)

Signal — стандартизированная запись о готовом сигнале для PortfolioRiskManager.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from risk import RiskManager
    from ic_ewa_store import SharedICEWAStore


@dataclass
class Signal:
    """
    Готовый сигнал от одного счёта — передаётся в PortfolioRiskManager.can_enter.

    ticker        — человеческий тикер ("SBER")
    direction     — "long" | "short"
    confidence    — уверенность сигнала [0, 1]
    risk_rub      — рублей на кону при данном стопе
    expected_bars — ожидаемый горизонт сделки в барах данного TF
    tf_minutes    — размер бара в минутах (1, 5, 60 и т.д.)
    account       — ссылка на TradingSystem-источник
    """
    ticker: str
    direction: str         # "long" | "short"
    confidence: float
    risk_rub: float
    expected_bars: int
    tf_minutes: int
    account: "TradingSystem | None" = field(default=None, repr=False)

    @property
    def horizon_minutes(self) -> float:
        return self.expected_bars * self.tf_minutes

    @property
    def priority(self) -> float:
        """confidence × log(горизонт в минутах) — чем выше, тем раньше входим."""
        h = max(1.0, self.horizon_minutes)
        return self.confidence * math.log(h)


class TradingSystem:
    """
    Один торговый счёт: стратегия + таймфрейм + плейбуки + риск-менеджер.

    strategy     — экземпляр OICompositeStrategy (передаётся снаружи)
    rm           — экземпляр RiskManager для этого счёта
    tf_minutes   — таймфрейм в минутах
    playbooks    — список разрешённых имён плейбуков (пустой = все)
    shared_store — SharedICEWAStore; если передан, стратегия получает
                   ic_bucket(tf) из него вместо внутреннего словаря
    label        — человеческое имя счёта для логов ("account_A")
    """

    def __init__(self, strategy, rm: "RiskManager", tf_minutes: int,
                 playbooks: list[str] | None = None,
                 shared_store: "SharedICEWAStore | None" = None,
                 label: str = ""):
        self.strategy = strategy
        self.rm = rm
        self.tf_minutes = tf_minutes
        self.playbooks: list[str] = playbooks or []
        self.shared_store = shared_store
        self.label = label or f"tf{tf_minutes}"

        # Подключить shared_store к стратегии если та поддерживает
        if shared_store is not None and hasattr(strategy, "set_shared_ic_store"):
            strategy.set_shared_ic_store(shared_store, tf_minutes)

    @property
    def equity(self) -> float:
        return self.rm.equity_getter()

    @property
    def daily_pnl_rub(self) -> float:
        return self.rm.state.get("day_pnl_rub", 0.0)

    @property
    def week_pnl_rub(self) -> float:
        return self.rm.state.get("week_pnl_rub", 0.0)

    @property
    def month_pnl_rub(self) -> float:
        return self.rm.state.get("month_pnl_rub", 0.0)

    @property
    def open_positions(self):
        return self.rm.positions

    @property
    def current_risk_rub(self) -> float:
        return sum(p.risk_rub for p in self.rm.positions.values())

    def __repr__(self):
        return f"TradingSystem({self.label}, tf={self.tf_minutes}m, pos={len(self.open_positions)})"
