"""
nw_memory_live.py — NW-память T/P/color для бота (Layer 4 / §11 концепции
kontseptsiya_temperatura_davlenie_pamyat_2.md).

Строит память ОДИН РАЗ на тикер из истории и потом на каждом баре быстро
отдаёт голос. Память = прошлые бары В КВАДРАНТЕ (lowT_highP) с известным
исходом: (T̂,P̂,color̂) + знак target + знак color + per-ticker пороги
квадранта. Запрос: если текущий бар в квадранте и есть прецеденты (density
≥ порога) → голос 2·p_hold−1, иначе 0.

Оси и разметку считает tpcolor_dataset.build_dataset — ТОТ ЖЕ расчёт, что
валидировался офлайн (walk-forward: 69% edge>0 на holdout). Решения по
итогам исследования зашиты:
- калибровку НЕ тащим (OOS не работает, raw p_hold — настоящий сигнал);
- инверсию по ликвидности НЕ делаем: у ликвидных тикеров p_hold≈0.5 →
  голос≈0 сам собой (память per-ticker), а не «переворот»; инвертирован
  лишь SBER-класс (выброс), его память отразит p_hold<0.5 естественно;
- рабочая зона одна: lowT_highP при t_pctl=5 / p_pctl=90.

scipy опционален: cKDTree если есть, иначе numpy brute-force (квадрант мал,
~0.5% баров — сотни точек, перебор дёшев). numpy обязателен; без него
build → None, score → 0.0 (метод молчит, бот не падает).
"""
from __future__ import annotations

import math
from typing import Optional

# Параметры — из валидированного офлайн-прогона (nw_memory.py / tpcolor_dataset.py)
_N = 20            # окно ATR/ER для осей
_N_MACRO = 200     # макро-окно (T_macro/P_macro, пока не используются)
_W_NORM = 500      # окно каузального rolling z-score (§11.1)
_K = 12            # горизонт fwd_ret (5-мин → ~60 мин)
_H = 0.3           # bandwidth гауссова ядра
_DENSITY_MIN = 3.0  # §5.4: density < порога → «нет прецедента» → 0
_T_PCTL = 5.0      # квадрант: T̂ ниже p5
_P_PCTL = 90.0     # квадрант: P̂ выше p90
_MIN_QUAD = 60     # минимум точек в квадранте, иначе память не строим


def _q_to_f(q) -> float:
    """Quotation(units/nano) или уже число → float."""
    try:
        return float(q.units) + float(q.nano) / 1e9
    except AttributeError:
        return float(q)


def _candles_to_dicts(candles: list) -> list[dict]:
    """Bot-свечи (HistoricCandle с Quotation) → dict-формат build_dataset."""
    out = []
    for c in candles:
        out.append({
            "time": getattr(c, "time", None),
            "open": _q_to_f(c.open), "high": _q_to_f(c.high),
            "low": _q_to_f(c.low), "close": _q_to_f(c.close),
            "volume": int(getattr(c, "volume", 0) or 0),
        })
    return out


def _axes_from_candles(candles: list, np):
    """T̂/P̂/color̂/target/outcome_known как numpy-массивы через build_dataset
    (единый источник осей с офлайном). None при нехватке баров."""
    import tpcolor_dataset as tpc
    rows = tpc.build_dataset(_candles_to_dicts(candles),
                             n=_N, n_macro=_N_MACRO, w_norm=_W_NORM, k=_K)
    if not rows:
        return None
    T = np.array([r["T_hat"] for r in rows], dtype=float)
    P = np.array([r["P_hat"] for r in rows], dtype=float)
    C = np.array([r["color_hat"] for r in rows], dtype=float)
    tgt = np.array([r["target"] for r in rows], dtype=float)
    ok = np.array([r["outcome_known"] for r in rows], dtype=float) == 1.0
    return T, P, C, tgt, ok


class NWMemory:
    """Память одного тикера. Строй через NWMemory.build(...), запрашивай score(...)."""

    def __init__(self, coords, tgt_pos, color_sign, t_thr, p_thr):
        self.coords = coords          # (m,3) точки квадранта из прошлого
        self.tgt_pos = tgt_pos        # (m,) 1.0 если target>0 иначе 0.0
        self.color_sign = color_sign  # (m,) знак color в этих точках
        self.t_thr = t_thr
        self.p_thr = p_thr
        self._tree = None
        try:
            from scipy.spatial import cKDTree
            self._tree = cKDTree(coords)
        except Exception:
            self._tree = None  # fallback на brute-force в score()

    @classmethod
    def build(cls, candles: list, min_quad: int = _MIN_QUAD) -> Optional["NWMemory"]:
        """Строит память из истории тикера. None если numpy нет, мало баров
        или мало точек в квадранте (тогда метод для тикера молчит)."""
        try:
            import numpy as np
        except ImportError:
            return None
        ax = _axes_from_candles(candles, np)
        if ax is None:
            return None
        T, P, C, tgt, ok = ax
        valid = ok & ~np.isnan(T) & ~np.isnan(P) & ~np.isnan(C) & ~np.isnan(tgt)
        if int(valid.sum()) < min_quad * 4:  # нужна глубина истории
            return None
        # Пороги квадранта — per-ticker перцентили по валидной истории.
        t_thr = float(np.percentile(T[valid], _T_PCTL))
        p_thr = float(np.percentile(P[valid], _P_PCTL))
        inq = valid & (T < t_thr) & (P > p_thr)
        if int(inq.sum()) < min_quad:
            return None
        coords = np.column_stack([T[inq], P[inq], C[inq]]).astype(float)
        tgt_pos = (tgt[inq] > 0).astype(float)
        color_sign = np.sign(C[inq])
        return cls(coords, tgt_pos, color_sign, t_thr, p_thr)

    def score(self, candles: list) -> float:
        """Голос для последнего бара окна candles. 0.0 если вне квадранта, нет
        прецедента, мало баров для осей или numpy отсутствует.

        ВАЖНО про окно: пересчитывает оси по всему переданному candles, т.е.
        стоимость O(len(candles)). Передавай ОГРАНИЧЕННЫЙ recent-хвост, не всю
        историю: нужно ≥ ~(_W_NORM + _N_MACRO + _K) ≈ 720 баров для валидных
        осей последнего бара, оптимально ~800. На 800 барах ~48мс/бар; на всей
        истории — секунды (для бэктеста звать на срезе candles[-800:])."""
        try:
            import numpy as np
        except ImportError:
            return 0.0
        ax = _axes_from_candles(candles, np)
        if ax is None:
            return 0.0
        T, P, C, _tgt, _ok = ax
        # Текущий бар — последний с валидными осями.
        t = p = c = None
        for i in range(len(T) - 1, -1, -1):
            if not (np.isnan(T[i]) or np.isnan(P[i]) or np.isnan(C[i])):
                t, p, c = float(T[i]), float(P[i]), float(C[i])
                break
        if t is None:
            return 0.0
        # В квадранте?
        if not (t < self.t_thr and p > self.p_thr):
            return 0.0
        q = np.array([t, p, c], dtype=float)
        radius = 3.0 * _H
        if self._tree is not None:
            idx = self._tree.query_ball_point(q, radius)
            if not idx:
                return 0.0
            sub = self.coords[idx]
            tpos = self.tgt_pos[idx]
            csign = self.color_sign[idx]
        else:
            d2all = ((self.coords - q) ** 2).sum(axis=1)
            mask = d2all <= radius * radius
            if not bool(mask.any()):
                return 0.0
            sub = self.coords[mask]
            tpos = self.tgt_pos[mask]
            csign = self.color_sign[mask]
        d2 = ((sub - q) ** 2).sum(axis=1)
        w = np.exp(-d2 / (2.0 * _H * _H))
        # §11.2 dir_match: жёсткий {0,1} по совпадению знака color.
        dir_match = (csign == np.sign(c)).astype(float)
        w_eff = w * dir_match
        dens = float(w_eff.sum())
        if dens < _DENSITY_MIN:  # §5.4 нет прецедента
            return 0.0
        p_hold = float((w_eff * tpos).sum() / dens)
        return max(-1.0, min(1.0, 2.0 * p_hold - 1.0))
