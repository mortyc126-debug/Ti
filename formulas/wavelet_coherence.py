import numpy as np


def wavelet_coherence(
    price_a: list | np.ndarray,
    price_b: list | np.ndarray,
    scales: list[int] | None = None,
    smoothing_window: int = 5,
    threshold: float = 0.7,
) -> dict:
    """
    Вычисляет вейвлет-когерентность между двумя инструментами по масштабам.

    Wavelet Coherence показывает, на каких временных горизонтах два инструмента
    движутся согласованно — и является ли эта связь устойчивой или случайной.
    В отличие от корреляции Пирсона, результат разложен по масштабам (периодам).

    Когерентность R²(scale) ∈ [0, 1]:
        → 1  — инструменты синхронны на данном масштабе
        → 0  — связи нет

    Фаза φ(scale):
        φ ≈ 0    — синфазное движение (co-movement)
        φ ≈ ±π  — противофазное движение (divergence)
        0 < φ < π — A опережает B
        -π < φ < 0 — B опережает A

    Args:
        price_a:          Ценовой ряд первого инструмента.
        price_b:          Ценовой ряд второго инструмента.
        scales:           Масштабы для анализа. По умолчанию — логарифмическая сетка.
        smoothing_window: Окно сглаживания спектров (влияет на стабильность оценки).
        threshold:        Порог когерентности для определения «связанных» масштабов.

    Returns:
        dict с ключами:
            'coherence_by_scale'   — {scale: coherence} для всех масштабов
            'phase_by_scale'       — {scale: phase_degrees} для всех масштабов
            'coherent_scales'      — масштабы выше порога когерентности
            'dominant_scale'       — масштаб с максимальной когерентностью
            'dominant_coherence'   — значение когерентности на dominant_scale
            'dominant_phase'       — фаза на dominant_scale (градусы)
            'dominant_relationship'— описание связи на доминантном масштабе
            'mean_coherence'       — средняя когерентность по всем масштабам
            'regime'               — 'strongly_coupled', 'weakly_coupled', 'decoupled'
    """
    a = np.array(price_a, dtype=float)
    b = np.array(price_b, dtype=float)

    if len(a) != len(b):
        raise ValueError("Ряды должны быть одинаковой длины.")
    if len(a) < 32:
        raise ValueError("Слишком короткий ряд. Минимум 32 точки.")

    # Нормализованные логарифмические доходности
    def to_returns(prices: np.ndarray) -> np.ndarray:
        r = np.diff(np.log(prices))
        std = r.std() + 1e-12
        return (r - r.mean()) / std

    ra = to_returns(a)
    rb = to_returns(b)
    n  = len(ra)

    if scales is None:
        max_scale = n // 4
        scales = [int(s) for s in np.unique(
            np.round(np.geomspace(2, max_scale, num=40)).astype(int)
        )]
        scales = [s for s in scales if 2 <= s <= max_scale]

    # Вейвлет Морле
    def morlet(t: np.ndarray, scale: float, omega0: float = 6.0) -> np.ndarray:
        x = t / scale
        norm = (np.pi ** -0.25) / np.sqrt(scale)
        return norm * np.exp(1j * omega0 * x) * np.exp(-0.5 * x ** 2)

    # CWT для одного ряда
    def cwt(signal: np.ndarray, scale: int) -> np.ndarray:
        half = min(int(4 * scale), n - 1)
        t_wav = np.arange(-half, half + 1, dtype=float)
        psi = morlet(t_wav, scale)
        wav_len = len(psi)
        coeffs = np.zeros(n, dtype=complex)
        for i in range(n):
            s_w = max(0, half - i)
            e_w = min(wav_len, half + (n - i))
            s_s = max(0, i - half)
            e_s = s_s + (e_w - s_w)
            if e_w > s_w:
                coeffs[i] = np.dot(psi[s_w:e_w], signal[s_s:e_s])
        return coeffs

    def smooth(x: np.ndarray, window: int) -> np.ndarray:
        if window < 2:
            return x
        kernel = np.ones(window) / window
        return np.convolve(x, kernel, mode="same")

    coherence_by_scale: dict[int, float] = {}
    phase_by_scale: dict[int, float]     = {}

    for scale in scales:
        wa = cwt(ra, scale)
        wb = cwt(rb, scale)

        # Кросс-спектр и авто-спектры
        cross  = wa * np.conj(wb)
        power_a = np.abs(wa) ** 2
        power_b = np.abs(wb) ** 2

        # Сглаживание
        cross_s   = smooth(np.real(cross), smoothing_window) + \
                    1j * smooth(np.imag(cross), smoothing_window)
        power_a_s = smooth(power_a, smoothing_window)
        power_b_s = smooth(power_b, smoothing_window)

        denom = power_a_s * power_b_s
        denom = np.where(denom < 1e-12, 1e-12, denom)

        coh = np.abs(cross_s) ** 2 / denom
        coh = np.clip(coh, 0.0, 1.0)

        coherence_by_scale[scale] = round(float(np.mean(coh)), 4)
        phase_by_scale[scale]     = round(float(np.degrees(np.angle(np.mean(cross_s)))), 2)

    # Доминантный масштаб
    dominant_scale     = max(coherence_by_scale, key=coherence_by_scale.get)
    dominant_coherence = coherence_by_scale[dominant_scale]
    dominant_phase     = phase_by_scale[dominant_scale]

    # Интерпретация фазы
    ap = abs(dominant_phase)
    if ap <= 30:
        dominant_relationship = "синфазное движение (co-movement)"
    elif ap >= 150:
        dominant_relationship = "противофазное движение (divergence)"
    elif 0 < dominant_phase < 180:
        dominant_relationship = "A опережает B"
    else:
        dominant_relationship = "B опережает A"

    # Связанные масштабы
    coherent_scales = sorted(s for s, c in coherence_by_scale.items() if c >= threshold)
    mean_coherence  = round(float(np.mean(list(coherence_by_scale.values()))), 4)

    if mean_coherence >= 0.65:
        regime = "strongly_coupled"
    elif mean_coherence >= 0.4:
        regime = "weakly_coupled"
    else:
        regime = "decoupled"

    return {
        "coherence_by_scale":    {s: coherence_by_scale[s] for s in sorted(coherence_by_scale)},
        "phase_by_scale":        {s: phase_by_scale[s]     for s in sorted(phase_by_scale)},
        "coherent_scales":       coherent_scales,
        "dominant_scale":        dominant_scale,
        "dominant_coherence":    dominant_coherence,
        "dominant_phase":        dominant_phase,
        "dominant_relationship": dominant_relationship,
        "mean_coherence":        mean_coherence,
        "regime":                regime,
    }


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    rng = np.random.default_rng(42)
    n = 256

    # Связанные инструменты: общий среднесрочный цикл + независимый шум
    t = np.arange(n, dtype=float)
    common = np.sin(2 * np.pi * t / 20)
    a = 100 + np.cumsum(0.4 * common + rng.standard_normal(n) * 0.1)
    b = 50  + np.cumsum(0.3 * common + rng.standard_normal(n) * 0.15)

    res = wavelet_coherence(a, b)
    print("Связанные инструменты:")
    for k, v in res.items():
        if k not in ("coherence_by_scale", "phase_by_scale"):
            print(f"  {k}: {v}")

    print()

    # Независимые инструменты
    a2 = 100 + np.cumsum(rng.standard_normal(n) * 0.5)
    b2 = 50  + np.cumsum(rng.standard_normal(n) * 0.5)

    res2 = wavelet_coherence(a2, b2)
    print("Независимые инструменты:")
    for k, v in res2.items():
        if k not in ("coherence_by_scale", "phase_by_scale"):
            print(f"  {k}: {v}")
