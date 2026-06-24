"""
joint_calibration.py — итеративная совместная калибровка параметров стратегии.

Порядок (из спецификации):
  1. IC lag per method          (независим, первым)
  2. Noise mode threshold       (зависит от IC)
  3. Signal threshold           (глобальный)      ┐
  4. L1 коэффициенты                              │ итерируются вместе
  5. Agreement threshold                          ┘ до сходимости (tol=2%)
  6. Session mult               (независим от 3-5)
  7. Vol mult границы           (независим)
  8. Trailing mult per playbook (зависит от threshold)
  9. Playbook activation levels (зависят от trailing)
"""
from __future__ import annotations

import math
import statistics
from typing import Callable


def converged(params_prev: dict, params_curr: dict, tol: float = 0.02) -> bool:
    """True если все числовые параметры изменились менее чем на tol (2%)."""
    for k in params_curr:
        if k not in params_prev:
            return False
        prev, curr = params_prev[k], params_curr[k]
        if not isinstance(prev, (int, float)):
            continue
        if abs(curr - prev) / (abs(prev) + 1e-8) >= tol:
            return False
    return True


def clip_step(new_val: float, prev_val: float, max_change: float = 0.30) -> float:
    """Ограничить изменение параметра за итерацию на ±max_change (30%)."""
    lo = prev_val * (1.0 - max_change)
    hi = prev_val * (1.0 + max_change)
    return max(lo, min(hi, new_val))


def _ir_score(r_list: list[float]) -> float:
    """mean(r) × sqrt(n) / std(r) — информационное отношение."""
    if not r_list:
        return float('-inf')
    mean_r = statistics.mean(r_list)
    std_r = statistics.stdev(r_list) if len(r_list) > 1 else 1.0
    return mean_r * math.sqrt(len(r_list)) / (std_r + 1e-6)


def calibrate_signal_threshold(
    signal_records: list[dict],
    candidates: list[float] | None = None,
    min_signals: int = 20,
) -> float:
    """
    Калибрует порог composite-сигнала по IR-критерию.

    signal_records — [{composite: float, r_multiple: float}, ...]
    """
    if candidates is None:
        candidates = [0.06, 0.08, 0.10, 0.12, 0.14, 0.16, 0.18, 0.20]
    best_thr, best_score = candidates[0], float('-inf')
    for thr in candidates:
        rs = [s['r_multiple'] for s in signal_records
              if abs(s.get('composite', 0.0)) >= thr]
        if len(rs) < min_signals:
            continue
        sc = _ir_score(rs)
        if sc > best_score:
            best_score, best_thr = sc, thr
    return best_thr


def calibrate_agreement_threshold(
    signal_records: list[dict],
    candidates: list[float] | None = None,
    min_signals: int = 20,
    regime: str | None = None,
) -> float:
    """
    Калибрует порог IC-взвешенного согласия методов по IR-критерию.

    agreement влияет на КАЧЕСТВО (консенсус методов),
    signal threshold — на СИЛУ composite. Параметры независимы.
    Per-regime: передать regime для отдельной калибровки.

    signal_records — [{ic_weighted_agreement: float, r_multiple: float,
                       regime: str}, ...]
    """
    if candidates is None:
        candidates = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65]
    records = signal_records
    if regime is not None:
        records = [s for s in records if s.get('regime') == regime]
    best_thr, best_score = candidates[0], float('-inf')
    for thr in candidates:
        rs = [s['r_multiple'] for s in records
              if s.get('ic_weighted_agreement', 0.0) >= thr]
        if len(rs) < min_signals:
            continue
        sc = _ir_score(rs)
        if sc > best_score:
            best_score, best_thr = sc, thr
    return best_thr


def calibrate_iterative(
    params_init: dict,
    calibrate_fns: list[Callable[[dict], dict]],
    tol: float = 0.02,
    max_iter: int = 10,
    max_change_per_iter: float = 0.30,
) -> tuple[dict, int]:
    """
    Итеративная совместная калибровка взаимозависимых параметров.

    params_init    — начальные значения {name: value}
    calibrate_fns  — [fn(params) → params_new, ...] в порядке шагов 3-5
    tol            — порог сходимости (2%)
    max_iter       — максимум итераций
    max_change_per_iter — ±30% изменения за итерацию (защита от расходимости)

    Возвращает (итоговые параметры, число итераций).

    Пример для шагов 3-5:
        fns = [
            lambda p: {'signal_thr': calibrate_signal_threshold(records, ...)},
            lambda p: {'l1_coeff':   calibrate_l1(records, p['signal_thr'])},
            lambda p: {'agree_thr':  calibrate_agreement_threshold(records)},
        ]
        params, n_iter = calibrate_iterative({'signal_thr': 0.10, ...}, fns)
    """
    params = dict(params_init)
    for iteration in range(1, max_iter + 1):
        params_prev = dict(params)
        for fn in calibrate_fns:
            new_params = fn(params)
            for k, v in new_params.items():
                if k in params and isinstance(params.get(k), (int, float)) \
                        and isinstance(v, (int, float)):
                    params[k] = clip_step(v, params_prev.get(k, v),
                                          max_change_per_iter)
                else:
                    params[k] = v
        if converged(params_prev, params, tol):
            return params, iteration
    return params, max_iter


def calibrate_playbook_activation_levels(
    mfe_distribution: dict[str, list[float]],
    percentiles: tuple[float, float, float] = (30.0, 50.0, 65.0),
    min_n: int = 8,
) -> dict[str, dict[str, float]]:
    """
    Per-playbook уровни активации скользящего безубытка из MFE percentiles.

    mfe_distribution — {playbook: [mfe_in_R, ...]}
    percentiles      — (breakeven, partial, trailing) — позиции в % MFE
    min_n            — минимум наблюдений для калибровки

    Возвращает {playbook: {'breakeven': R, 'partial': R, 'trailing': R}}.
    Передаётся в open_position(activation_levels=...) и хранится на Position.
    """
    result = {}
    p_be, p_part, p_trail = percentiles
    for pb, mfe_list in mfe_distribution.items():
        if len(mfe_list) < min_n:
            continue
        srt = sorted(mfe_list)
        n = len(srt)

        def _pct(p: float) -> float:
            return srt[max(0, min(n - 1, int(p / 100 * n)))]

        result[pb] = {
            'breakeven': max(0.30, _pct(p_be)),
            'partial':   max(0.50, _pct(p_part)),
            'trailing':  max(0.75, _pct(p_trail)),
        }
    return result
