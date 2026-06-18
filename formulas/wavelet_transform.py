import numpy as np


def wavelet_transform(
    price_series: list | np.ndarray,
    scales: list[int] | None = None,
    wavelet: str = "morlet",
    threshold_ratio: float = 0.2,
) -> dict:
    """
    Применяет непрерывное вейвлет-преобразование (CWT) к ценовому ряду
    для определения активных временных масштабов.

    Метод декомпозирует сигнал по масштабам (периодам), позволяя увидеть,
    на каком горизонте сосредоточена основная энергия движения:
    скальпинг, внутридневной тренд, свинг или долгосрочный цикл.

    Поддерживаемые вейвлеты:
        'morlet'  — оптимален для анализа частот в трейдинге (по умолчанию)
        'ricker'  — Mexican hat, хорошо выделяет пики и локальные паттерны

    Интерпретация масштабов (в единицах баров):
        scale 2–8    — краткосрочный (скальпинг / микроструктура)
        scale 8–32   — среднесрочный (внутридневной тренд)
        scale 32–128 — долгосрочный (свинг / цикл)
        scale > 128  — макро-цикл

    Args:
        price_series:    Ценовой ряд (close prices), минимум 32 точки.
        scales:          Список масштабов для анализа. По умолчанию — логарифмическая
                         сетка от 2 до len/4.
        wavelet:         Тип вейвлета: 'morlet' или 'ricker'.
        threshold_ratio: Порог для определения «активного» масштаба —
                         доля от максимальной энергии (по умолчанию 0.2).

    Returns:
        dict с ключами:
            'dominant_scale'      — масштаб с максимальной энергией (в барах)
            'dominant_period'     — интерпретация dominant_scale как периода
            'active_scales'       — масштабы выше порога энергии
            'energy_by_scale'     — словарь {scale: energy} для всех масштабов
            'regime'              — 'short_term', 'medium_term', 'long_term', 'macro'
            'energy_distribution' — доля энергии по трём диапазонам (short/mid/long)
            'signal_clarity'      — отношение энергии доминанты ко всей энергии (0–1)
    """
    ts = np.array(price_series, dtype=float)
    n = len(ts)

    if n < 32:
        raise ValueError("Слишком короткий ряд. Минимум 32 точки.")

    # Логарифмические доходности и нормализация
    returns = np.diff(np.log(ts))
    returns = (returns - returns.mean()) / (returns.std() + 1e-12)

    if scales is None:
        max_scale = n // 4
        scales = [int(s) for s in np.unique(
            np.round(np.geomspace(2, max_scale, num=40)).astype(int)
        )]
        scales = [s for s in scales if 2 <= s <= max_scale]

    # --- Вейвлет-функции ---
    def morlet_wavelet(t: np.ndarray, scale: float, omega0: float = 6.0) -> np.ndarray:
        """Комплексный вейвлет Морле."""
        x = t / scale
        norm = (np.pi ** -0.25) / np.sqrt(scale)
        return norm * np.exp(1j * omega0 * x) * np.exp(-0.5 * x ** 2)

    def ricker_wavelet(t: np.ndarray, scale: float) -> np.ndarray:
        """Вейвлет Рикера (Mexican hat) — вещественный."""
        x = t / scale
        norm = (2.0 / (np.sqrt(3 * scale) * np.pi ** 0.25))
        return norm * (1 - x ** 2) * np.exp(-0.5 * x ** 2)

    # --- CWT ---
    t_idx = np.arange(len(returns), dtype=float)
    energy_by_scale: dict[int, float] = {}

    for scale in scales:
        # Окно вейвлета: ±4σ относительно масштаба
        half_width = min(int(4 * scale), len(returns) - 1)
        t_wav = np.arange(-half_width, half_width + 1, dtype=float)

        if wavelet == "morlet":
            psi = morlet_wavelet(t_wav, scale)
        elif wavelet == "ricker":
            psi = ricker_wavelet(t_wav, scale)
        else:
            raise ValueError(f"Неизвестный вейвлет: '{wavelet}'. Используйте 'morlet' или 'ricker'.")

        # Свёртка через прямую сумму (не FFT, чтобы не зависеть от scipy)
        wav_len = len(psi)
        sig_len = len(returns)
        coeffs = np.zeros(sig_len, dtype=complex if wavelet == "morlet" else float)

        for i in range(sig_len):
            start_w = max(0, half_width - i)
            end_w   = min(wav_len, half_width + (sig_len - i))
            start_s = max(0, i - half_width)
            end_s   = start_s + (end_w - start_w)
            if end_w > start_w:
                coeffs[i] = np.dot(psi[start_w:end_w], returns[start_s:end_s])

        energy_by_scale[scale] = float(np.mean(np.abs(coeffs) ** 2))

    # --- Доминантный масштаб ---
    dominant_scale = max(energy_by_scale, key=energy_by_scale.get)
    total_energy   = sum(energy_by_scale.values())
    max_energy     = energy_by_scale[dominant_scale]

    # Активные масштабы
    active_threshold = max_energy * threshold_ratio
    active_scales    = sorted(s for s, e in energy_by_scale.items() if e >= active_threshold)

    # Ясность сигнала
    signal_clarity = round(max_energy / total_energy, 4) if total_energy > 0 else 0.0

    # Режим по доминантному масштабу
    if dominant_scale <= 8:
        regime = "short_term"
        dominant_period = "скальпинг / микроструктура"
    elif dominant_scale <= 32:
        regime = "medium_term"
        dominant_period = "внутридневной тренд"
    elif dominant_scale <= 128:
        regime = "long_term"
        dominant_period = "свинг / цикл"
    else:
        regime = "macro"
        dominant_period = "макро-цикл"

    # Распределение энергии по диапазонам
    short_energy = sum(e for s, e in energy_by_scale.items() if s <= 8)
    mid_energy   = sum(e for s, e in energy_by_scale.items() if 8 < s <= 32)
    long_energy  = sum(e for s, e in energy_by_scale.items() if s > 32)

    energy_distribution = {
        "short_term": round(short_energy / total_energy, 4) if total_energy > 0 else 0.0,
        "medium_term": round(mid_energy  / total_energy, 4) if total_energy > 0 else 0.0,
        "long_term":  round(long_energy  / total_energy, 4) if total_energy > 0 else 0.0,
    }

    return {
        "dominant_scale": dominant_scale,
        "dominant_period": dominant_period,
        "active_scales": active_scales,
        "energy_by_scale": {s: round(e, 6) for s, e in sorted(energy_by_scale.items())},
        "regime": regime,
        "energy_distribution": energy_distribution,
        "signal_clarity": signal_clarity,
    }


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    rng = np.random.default_rng(42)
    n = 256

    # Сигнал с явным среднесрочным циклом (период ~20 баров)
    t = np.arange(n, dtype=float)
    cycle_prices = 100 + np.cumsum(
        0.3 * np.sin(2 * np.pi * t / 20) + rng.standard_normal(n) * 0.1
    )
    res = wavelet_transform(cycle_prices)
    print("Среднесрочный цикл:")
    for k, v in res.items():
        if k != "energy_by_scale":
            print(f"  {k}: {v}")

    print()

    # Чистый шум
    noise_prices = 100 + np.cumsum(rng.standard_normal(n) * 0.5)
    res = wavelet_transform(noise_prices)
    print("Случайное блуждание:")
    for k, v in res.items():
        if k != "energy_by_scale":
            print(f"  {k}: {v}")
