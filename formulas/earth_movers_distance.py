import numpy as np


def earth_movers_distance(
    distribution_a: list | np.ndarray,
    distribution_b: list | np.ndarray,
    bins: int = 50,
    window_size: int | None = None,
    threshold_shift: float = 0.3,
) -> dict:
    """
    Вычисляет Earth Mover's Distance (EMD / Wasserstein-1) между двумя
    распределениями ликвидности или объёма.

    EMD измеряет минимальную «работу» по преобразованию одного распределения
    в другое — интуитивно: сколько земли нужно переместить, чтобы сравнять
    один холм с другим. В контексте трейдинга это показывает, насколько
    сильно перестроилась структура ликвидности между двумя периодами.

    Для одномерных распределений EMD = Wasserstein-1 и вычисляется точно
    через интеграл |CDF_A(x) - CDF_B(x)| dx без итеративной оптимизации.

    Интерпретация:
        emd ≈ 0      — распределения идентичны, ликвидность не перестраивалась
        emd растёт   — структура ликвидности меняется
        emd > threshold_shift — значимая перестройка ликвидности

    Args:
        distribution_a:  Первое распределение (цены, объёмы, bid/ask уровни).
        distribution_b:  Второе распределение для сравнения с A.
        bins:            Число бинов для построения гистограмм.
        window_size:     Если задан — дополнительно вычисляет rolling EMD
                         по скользящему окну внутри distribution_a vs distribution_b.
        threshold_shift: Порог EMD для классификации перестройки ликвидности.

    Returns:
        dict с ключами:
            'emd'                  — Earth Mover's Distance между A и B
            'normalized_emd'       — EMD нормированный на диапазон данных (0–1)
            'classification'       — 'stable', 'shifting', 'restructured'
            'confidence'           — уверенность классификации (0.0–1.0)
            'cdf_overlap'          — перекрытие CDF двух распределений (0–1)
            'center_shift'         — смещение медианы B относительно A
            'spread_change'        — изменение IQR (межквартильного размаха)
            'rolling_emd'          — список (emd, position) по окнам, если window_size задан
            'liquidity_regime'     — 'concentrated', 'dispersed', 'bimodal' по форме B
    """
    a = np.array(distribution_a, dtype=float).ravel()
    b = np.array(distribution_b, dtype=float).ravel()

    if len(a) < 2 or len(b) < 2:
        raise ValueError("Каждое распределение должно содержать минимум 2 точки.")

    # Общий диапазон для совместимых гистограмм
    global_min = min(a.min(), b.min())
    global_max = max(a.max(), b.max())
    data_range = global_max - global_min

    if data_range < 1e-12:
        return {
            "emd": 0.0, "normalized_emd": 0.0,
            "classification": "stable", "confidence": 1.0,
            "cdf_overlap": 1.0, "center_shift": 0.0,
            "spread_change": 0.0, "rolling_emd": [],
            "liquidity_regime": "concentrated",
        }

    edges = np.linspace(global_min, global_max, bins + 1)

    def to_pdf(arr: np.ndarray) -> np.ndarray:
        counts, _ = np.histogram(arr, bins=edges)
        total = counts.sum()
        return counts / total if total > 0 else counts.astype(float)

    def emd_1d(pdf_x: np.ndarray, pdf_y: np.ndarray, bin_width: float) -> float:
        """Wasserstein-1 через интеграл абсолютной разности CDF."""
        cdf_x = np.cumsum(pdf_x)
        cdf_y = np.cumsum(pdf_y)
        return float(np.sum(np.abs(cdf_x - cdf_y)) * bin_width)

    bin_width = data_range / bins
    pdf_a = to_pdf(a)
    pdf_b = to_pdf(b)

    emd_val       = emd_1d(pdf_a, pdf_b, bin_width)
    normalized_emd = min(emd_val / data_range, 1.0) if data_range > 0 else 0.0

    # CDF-перекрытие (Bhattacharyya-like через минимум)
    cdf_a = np.cumsum(pdf_a)
    cdf_b = np.cumsum(pdf_b)
    cdf_overlap = round(float(np.sum(np.minimum(pdf_a, pdf_b))), 4)

    # Смещение медианы и изменение IQR
    center_shift  = round(float(np.median(b) - np.median(a)), 6)
    iqr_a = float(np.percentile(a, 75) - np.percentile(a, 25))
    iqr_b = float(np.percentile(b, 75) - np.percentile(b, 25))
    spread_change = round(iqr_b - iqr_a, 6)

    # Классификация перестройки
    if normalized_emd < threshold_shift * 0.4:
        classification = "stable"
        confidence = round(1.0 - normalized_emd / (threshold_shift * 0.4 + 1e-12), 4)
    elif normalized_emd < threshold_shift:
        classification = "shifting"
        confidence = round(normalized_emd / threshold_shift, 4)
    else:
        classification = "restructured"
        confidence = round(min(normalized_emd / threshold_shift - 1.0, 1.0), 4)

    # Режим ликвидности по форме распределения B
    skewness_b = float(np.mean(((b - b.mean()) / (b.std() + 1e-12)) ** 3))
    kurt_b     = float(np.mean(((b - b.mean()) / (b.std() + 1e-12)) ** 4)) - 3.0

    if kurt_b > 1.0:
        liquidity_regime = "concentrated"   # острый пик — ликвидность сосредоточена
    elif kurt_b < -0.5:
        liquidity_regime = "bimodal"        # плоское/двугорбое — два кластера ликвидности
    else:
        liquidity_regime = "dispersed"      # равномерно распределена

    # Rolling EMD
    rolling_emd = []
    if window_size is not None and window_size >= 4:
        n_a, n_b = len(a), len(b)
        step = max(1, window_size // 4)
        positions = range(0, min(n_a, n_b) - window_size + 1, step)
        for pos in positions:
            w_a = a[pos: pos + window_size]
            w_b = b[pos: pos + window_size]
            p_a = to_pdf(w_a)
            p_b = to_pdf(w_b)
            w_emd = emd_1d(p_a, p_b, bin_width)
            rolling_emd.append((pos, round(w_emd, 6)))

    return {
        "emd":               round(emd_val, 6),
        "normalized_emd":    round(normalized_emd, 4),
        "classification":    classification,
        "confidence":        confidence,
        "cdf_overlap":       cdf_overlap,
        "center_shift":      center_shift,
        "spread_change":     round(spread_change, 6),
        "rolling_emd":       rolling_emd,
        "liquidity_regime":  liquidity_regime,
    }


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    rng = np.random.default_rng(42)

    # Стабильная ликвидность — похожие распределения объёма
    vol_before = rng.normal(loc=1000, scale=100, size=300)
    vol_after  = rng.normal(loc=1020, scale=110, size=300)
    res = earth_movers_distance(vol_before, vol_after)
    print("Стабильная ликвидность:")
    for k, v in res.items():
        if k != "rolling_emd":
            print(f"  {k}: {v}")

    print()

    # Перестройка ликвидности — объём сместился в другой ценовой диапазон
    vol_normal = rng.normal(loc=1000, scale=80,  size=300)
    vol_shifted = rng.normal(loc=1400, scale=200, size=300)
    res = earth_movers_distance(vol_normal, vol_shifted, window_size=60)
    print("Перестройка ликвидности:")
    for k, v in res.items():
        if k != "rolling_emd":
            print(f"  {k}: {v}")
    print(f"  rolling_emd (первые 3): {res['rolling_emd'][:3]}")
