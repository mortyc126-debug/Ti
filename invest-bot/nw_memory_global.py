"""
nw_memory_global.py — кросс-тикерная NW-память из ГЛОБАЛЬНОГО банка для live.

Отличие от nw_memory_live.NWMemory (per-ticker): память тут — ЕДИНЫЙ банк по
всем тикерам (nw_bank_build.py), а не квадрант одного тикера. Именно эта версия
валидирована в nw_backtest.py: чистая альфа +0.055 ATR OOS сверх беты и зоны,
бьёт локальную память. Зона и радиус — из бэктеста, НЕ per-ticker перцентили.

Запрос по живому бару: считаем оси (тот же tpcolor_dataset.build_dataset), берём
последний валидный бар; если он в зоне (T_hat<t_max, P_hat>p_min) — ищем соседей
в банке в жёстком радиусе; если их ≥ min_neighbors — голос = знак (p_hold−0.5),
где p_hold = доля соседей с исходом «вверх». Веса НЕ ставим (в бэктесте невзвеш.
среднее), калибровку НЕ тащим (OOS не работает — как и в per-ticker выводах).

scipy обязателен для KDTree (банк большой, brute-force не потянет). numpy тоже.
Без них load → None (метод молчит, бот не падает).
"""
from __future__ import annotations

import os
from typing import Optional

# Параметры зоны/радиуса — из валидированного nw_backtest.py.
_T_MAX = -0.4
_P_MIN = 0.6
_RADIUS = 0.12
_MIN_NEIGHBORS = 20
# Оси — те же, что офлайн/в банке (совпадают с nw_memory_live).
_N = 20
_N_MACRO = 200
_W_NORM = 500
_K = 12

_DEFAULT_BANK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "nw_bank.npz")


def _axes_from_candles(candles: list, np):
    """T̂/P̂/color̂ последнего валидного бара окна. None при нехватке баров."""
    import tpcolor_dataset as tpc
    rows = tpc.build_dataset(candles, n=_N, n_macro=_N_MACRO, w_norm=_W_NORM, k=_K)
    if not rows:
        return None
    for r in reversed(rows):
        t, p, c = r["T_hat"], r["P_hat"], r["color_hat"]
        if t is not None and p is not None and c is not None:
            return float(t), float(p), float(c)
    return None


class NWMemoryGlobal:
    """Глобальный банк. Строй через NWMemoryGlobal.load(...), запрашивай score(...)."""

    def __init__(self, coords, y, tree, path=None, mtime=0.0):
        self.coords = coords   # (N,3) float32
        self.y = y             # (N,) int8: 1 если target>0
        self._tree = tree
        self._path = path      # для горячей перезагрузки
        self._mtime = mtime

    @classmethod
    def load(cls, path: Optional[str] = None) -> Optional["NWMemoryGlobal"]:
        """Грузит банк .npz и строит KDTree один раз. None если нет файла/scipy/numpy."""
        try:
            import numpy as np
            from scipy.spatial import cKDTree
        except ImportError:
            return None
        path = path or _DEFAULT_BANK
        if not os.path.exists(path):
            return None
        try:
            mtime = os.path.getmtime(path)
            d = np.load(path)
            coords = d["coords"].astype(np.float64)
            y = d["y"].astype(np.float64)
        except (OSError, KeyError, ValueError):
            return None
        if len(coords) < _MIN_NEIGHBORS:
            return None
        return cls(coords, y, cKDTree(coords), path=path, mtime=mtime)

    def maybe_reload(self) -> bool:
        """Горячая перезагрузка: если файл банка обновился (ночной nw_bank_refresh),
        перечитывает его и пересобирает дерево на месте. True если перезагрузился.
        Дёшево (один os.stat) — зови раз в день/на смене дня, не на каждом баре."""
        if not self._path:
            return False
        try:
            mt = os.path.getmtime(self._path)
        except OSError:
            return False
        if mt <= self._mtime:
            return False
        fresh = NWMemoryGlobal.load(self._path)
        if fresh is None:
            return False
        self.coords, self.y, self._tree, self._mtime = fresh.coords, fresh.y, fresh._tree, fresh._mtime
        return True

    def score(self, candles: list) -> float:
        """Голос 2·p_hold−1 для последнего бара окна. 0.0 вне зоны / мало соседей /
        мало баров для осей / нет numpy. Как в nw_memory_live: короткий recent-хвост,
        стоимость O(len(candles)) на пересчёт осей — передавай ~800 баров, не всю
        историю."""
        try:
            import numpy as np
        except ImportError:
            return 0.0
        ax = _axes_from_candles(candles, np)
        if ax is None:
            return 0.0
        return self.score_axes(ax[0], ax[1], ax[2])

    def score_axes(self, t: float, p: float, c: float) -> float:
        """Голос по готовым осям бара (для бэктеста/переиспользования расчёта осей)."""
        try:
            import numpy as np
        except ImportError:
            return 0.0
        if not (t < _T_MAX and p > _P_MIN):   # вне зоны — молчим
            return 0.0
        idx = self._tree.query_ball_point([t, p, c], _RADIUS)
        if len(idx) < _MIN_NEIGHBORS:
            return 0.0
        p_hold = float(self.y[idx].mean())
        if p_hold == 0.5:
            return 0.0
        return max(-1.0, min(1.0, 2.0 * p_hold - 1.0))
