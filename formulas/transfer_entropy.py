import numpy as np
from collections import Counter


def calculate_transfer_entropy(
    source: list | np.ndarray,
    target: list | np.ndarray,
    lag: int = 1,
    bins: int = 10,
) -> dict:
    """
    Вычисляет Transfer Entropy (TE) от source → target и target → source.

    Transfer Entropy измеряет направленный информационный поток:
    насколько прошлое ряда X снижает неопределённость будущего ряда Y
    сверх того, что уже объясняет собственное прошлое Y.

    Формула:
        TE(X→Y) = Σ p(y_{t+1}, y_t, x_t) * log[ p(y_{t+1} | y_t, x_t) / p(y_{t+1} | y_t) ]

    Интерпретация:
        TE(source→target) > TE(target→source)  — source предсказывает target
        TE(target→source) > TE(source→target)  — target предсказывает source
        net_te > 0                              — доминирует поток source → target
        net_te < 0                              — доминирует поток target → source

    Args:
        source: Первый ценовой ряд (напр. BTC).
        target: Второй ценовой ряд (напр. ETH).
        lag:    Лаг (количество шагов назад), по умолчанию 1.
        bins:   Количество бинов для дискретизации доходностей.

    Returns:
        dict с ключами:
            'te_source_to_target' — TE от source к target (bits)
            'te_target_to_source' — TE от target к source (bits)
            'net_te'              — разница: source→target минус target→source
            'dominant_direction'  — 'source→target', 'target→source' или 'neutral'
            'confidence'          — относительная уверенность (0.0–1.0)
    """
    src = np.array(source, dtype=float)
    tgt = np.array(target, dtype=float)

    if len(src) != len(tgt):
        raise ValueError("Ряды должны быть одинаковой длины.")
    if len(src) < 30:
        raise ValueError("Слишком короткий ряд. Минимум 30 точек.")

    # Логарифмические доходности
    src_ret = np.diff(np.log(src))
    tgt_ret = np.diff(np.log(tgt))

    # Дискретизация через квантильные бины
    def discretize(arr: np.ndarray, n_bins: int) -> np.ndarray:
        quantiles = np.linspace(0, 100, n_bins + 1)
        edges = np.percentile(arr, quantiles)
        edges = np.unique(edges)
        return np.digitize(arr, edges[1:-1])

    src_d = discretize(src_ret, bins)
    tgt_d = discretize(tgt_ret, bins)

    def transfer_entropy(x: np.ndarray, y: np.ndarray, k: int) -> float:
        """TE от x → y с лагом k."""
        n = len(y) - k

        # Тройки: (y_{t+k}, y_t, x_t)
        y_future = y[k:]
        y_past   = y[:n]
        x_past   = x[:n]

        # Совместное распределение p(y_{t+k}, y_t, x_t)
        joint_xyz = Counter(zip(y_future, y_past, x_past))
        # p(y_t, x_t)
        joint_yx  = Counter(zip(y_past, x_past))
        # p(y_{t+k}, y_t)
        joint_yy  = Counter(zip(y_future, y_past))
        # p(y_t)
        marg_y    = Counter(y_past)

        total = float(n)
        te = 0.0

        for (yf, yp, xp), cnt in joint_xyz.items():
            p_xyz  = cnt / total
            p_yx   = joint_yx[(yp, xp)] / total
            p_yy   = joint_yy[(yf, yp)] / total
            p_y    = marg_y[yp] / total

            if p_xyz > 0 and p_yx > 0 and p_yy > 0 and p_y > 0:
                # log2 → результат в битах
                te += p_xyz * np.log2((p_xyz * p_y) / (p_yx * p_yy))

        return max(te, 0.0)  # TE неотрицательна по определению

    te_s2t = transfer_entropy(src_d, tgt_d, lag)
    te_t2s = transfer_entropy(tgt_d, src_d, lag)

    net_te = round(te_s2t - te_t2s, 6)
    total  = te_s2t + te_t2s

    # Направление
    threshold = 1e-6
    if abs(net_te) < threshold or total < threshold:
        dominant = "neutral"
        confidence = 0.0
    elif net_te > 0:
        dominant = "source→target"
        confidence = round(abs(net_te) / total, 4)
    else:
        dominant = "target→source"
        confidence = round(abs(net_te) / total, 4)

    return {
        "te_source_to_target": round(te_s2t, 6),
        "te_target_to_source": round(te_t2s, 6),
        "net_te": net_te,
        "dominant_direction": dominant,
        "confidence": confidence,
    }


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    np.random.seed(42)
    n = 500

    # BTC — лидер, ETH следует за ним с небольшим шумом
    btc = 100 + np.cumsum(np.random.randn(n))
    eth = 50  + np.cumsum(np.diff(btc, prepend=btc[0]) * 0.8 + np.random.randn(n) * 0.5)

    result = calculate_transfer_entropy(btc, eth, lag=1, bins=10)
    print("BTC (source) → ETH (target):")
    for k, v in result.items():
        print(f"  {k}: {v}")
