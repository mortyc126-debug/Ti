"""
indicators_multi.py — межинструментальные сигналы (Wave 3).

Считают связь между двумя инструментами (или корзиной), используя научные
модули из formulas/: transfer entropy (кто кого ведёт), wavelet coherence
(на каких горизонтах синхронны), random matrix theory (очистка корреляций от
шума). Все обёрнуты в try/except — без numpy/scipy функции деградируют до
нейтрального результата, бот продолжает работать на базовых методах.

Внешний код (Trader/провайдер) подаёт ряды цен; стратегия видит только
готовый скаляр через set_multi_ticker_provider.
"""
import math
import os
import sys

# formulas/ — на уровень выше каталога invest-bot/ (как и в regime.py).
_FORMULAS_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "formulas"))
if os.path.isdir(_FORMULAS_DIR) and _FORMULAS_DIR not in sys.path:
    sys.path.insert(0, _FORMULAS_DIR)

try:
    import numpy as np
    _HAS_NUMPY = True
except Exception:
    _HAS_NUMPY = False

try:
    from transfer_entropy import calculate_transfer_entropy
    _HAS_TE = True
except Exception:
    _HAS_TE = False

try:
    from wavelet_coherence import wavelet_coherence
    _HAS_WC = True
except Exception:
    _HAS_WC = False

try:
    from random_matrix_theory import random_matrix_theory  # noqa: F401 (используется через eigvals ниже)
    _HAS_RMT = True
except Exception:
    _HAS_RMT = False

__all__ = ("transfer_entropy_score", "wavelet_coherence_score", "rmt_corr_weight")


def transfer_entropy_score(closes_a: list, closes_b: list) -> float:
    """
    Направленный поток информации A→B минус B→A, нормированный tanh в [-1,1].

    > 0 — A ведёт B (движение A предсказывает B): если A — наш инструмент,
          это опережающий сигнал по B и наоборот.
    Возвращает net_te через tanh: насыщение при сильной асимметрии потока.
    Без numpy/модуля или коротком ряде — 0.0 (нейтрально).
    """
    if not _HAS_TE or len(closes_a) != len(closes_b) or len(closes_a) < 30:
        return 0.0
    try:
        res = calculate_transfer_entropy(closes_a, closes_b, lag=1, bins=10)
        net = res["te_source_to_target"] - res["te_target_to_source"]
        # net_te в битах обычно мал (<0.1); масштаб 10 даёт чувствительность.
        return max(-1.0, min(1.0, math.tanh(net * 10.0)))
    except Exception:
        return 0.0


def wavelet_coherence_score(closes_a: list, closes_b: list) -> float:
    """
    Средняя вейвлет-когерентность на среднесрочных масштабах 8–32 бара
    (внутридневной тренд). Возвращает [0,1]: 1 — инструменты синхронны на этом
    горизонте, 0 — связи нет. Полезно как вес/уверенность пары, а не направление.
    Без numpy/модуля или коротком ряде — 0.0.
    """
    if not _HAS_WC or len(closes_a) != len(closes_b) or len(closes_a) < 32:
        return 0.0
    try:
        n = len(closes_a)
        scales = [s for s in range(8, 33) if s <= n // 4]
        if not scales:
            scales = None
        res = wavelet_coherence(closes_a, closes_b, scales=scales)
        coh = res["coherence_by_scale"]
        mid = [v for s, v in coh.items() if 8 <= s <= 32]
        if not mid:
            return float(res["mean_coherence"])
        return max(0.0, min(1.0, sum(mid) / len(mid)))
    except Exception:
        return 0.0


def rmt_corr_weight(price_matrix) -> "np.ndarray":
    """
    RMT-очищенная корреляционная матрица: собственные значения внутри
    марченко-пастуровского диапазона (шум) обнуляются, остаются только
    реальные корреляции (информация). Возвращает очищенную матрицу (N×N),
    пригодную для взвешивания корзины инструментов.

    price_matrix: 2D (T наблюдений × N активов).
    Без numpy — возвращает None (вызывающий код должен это учесть).
    """
    if not _HAS_NUMPY:
        return None
    try:
        prices = np.asarray(price_matrix, dtype=float)
        if prices.ndim != 2 or prices.shape[1] < 2 or prices.shape[0] <= prices.shape[1]:
            return None
        returns = np.diff(np.log(prices), axis=0)
        T_ret, N = returns.shape
        mean = returns.mean(axis=0)
        std = returns.std(axis=0, ddof=1)
        std[std == 0] = 1.0
        norm = (returns - mean) / std
        corr = np.corrcoef(norm.T)

        # Спектральное разложение симметричной матрицы корреляций
        vals, vecs = np.linalg.eigh(corr)
        q = T_ret / N
        lambda_max = (1.0 + 1.0 / np.sqrt(q)) ** 2

        # Зануляем шумовые собственные значения (внутри диапазона Марченко-Пастура),
        # восстанавливаем матрицу только из сигнальных компонент.
        cleaned_vals = np.where(vals > lambda_max, vals, 0.0)
        cleaned = (vecs * cleaned_vals) @ vecs.T

        # Восстанавливаем единичную диагональ (корреляция актива с собой = 1).
        diag = np.diag(cleaned).copy()
        diag[diag <= 0] = 1.0
        d = np.sqrt(diag)
        cleaned = cleaned / np.outer(d, d)
        np.fill_diagonal(cleaned, 1.0)
        return cleaned
    except Exception:
        return None
