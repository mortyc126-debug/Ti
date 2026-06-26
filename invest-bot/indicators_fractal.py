"""
indicators_fractal.py — Фаза 3 (часть 2): фрактальный анализ + энтропия из
indicators-lib.js. Чистые функции от ценового ряда.

FDI/Hurst/PFE — для них в indlab_v10.html есть готовые ilScore*-обёртки
(value -> дискретный score), портированы как есть. Энтропия (Shannon/
Permutation) своей score-обёртки не имела — здесь сведена к одному
ENTROPY-методу: низкая энтропия (предсказуемое движение) усиливает текущее
направление тренда, высокая (шум) — гасит сигнал к нулю.
"""
import math

__all__ = ("fdi", "hurst_exponent", "pfe", "shannon_entropy", "permutation_entropy",
           "score_fractal", "score_entropy_regime",
           "choppiness_index", "efficiency_ratio", "chop_energy_mult")


def fdi(closes: list[float], period: int = 30) -> float:
    """Fractal Dimension Index, типично ~1.5-1.7 для тренда, ~2 для шума."""
    window = closes[-period:]
    if len(window) < 3:
        return 1.5
    mx, mn = max(window), min(window)
    rng = (mx - mn) or 1.0
    length = sum(abs(window[j] - window[j - 1]) / rng for j in range(1, len(window)))
    if length <= 0:
        return 1.5
    return 1 + (math.log(length) + math.log(2)) / math.log(2 * (period - 1))


def _score_fdi(v: float) -> float:
    """Порт ilScoreFDI: ниже 1.35 — сильный тренд (+1), выше 1.65 — шум (-0.5)."""
    if v < 1.35:
        return 1.0
    if v > 1.65:
        return -0.5
    return 0.0


def hurst_exponent(closes: list[float], min_window: int = 8) -> float:
    """R/S-анализ через лог-линейную регрессию log(R/S) ~ H*log(size). 0.5 = случайное блуждание."""
    n = len(closes)
    if n < min_window * 3:
        return 0.5
    log_returns = [math.log(closes[i] / closes[i - 1]) for i in range(1, n) if closes[i - 1] > 0 and closes[i] > 0]
    if len(log_returns) < min_window * 2:
        return 0.5

    sizes = []
    log_rs = []
    size = min_window
    while size <= len(log_returns) // 2:
        chunks = [log_returns[i:i + size] for i in range(0, len(log_returns) - size + 1, size)]
        rs_vals = []
        for chunk in chunks:
            if len(chunk) < 2:
                continue
            m = sum(chunk) / len(chunk)
            dev = [x - m for x in chunk]
            cum = 0.0
            cum_series = []
            for x in dev:
                cum += x
                cum_series.append(cum)
            rng = max(cum_series) - min(cum_series)
            sd = (sum(x * x for x in dev) / len(dev)) ** 0.5
            if sd > 0:
                rs_vals.append(rng / sd)
        if rs_vals:
            sizes.append(size)
            log_rs.append(math.log(sum(rs_vals) / len(rs_vals)))
        size *= 2

    if len(sizes) < 2:
        return 0.5
    log_sizes = [math.log(s) for s in sizes]
    n_pts = len(log_sizes)
    mx, my = sum(log_sizes) / n_pts, sum(log_rs) / n_pts
    num = sum((log_sizes[i] - mx) * (log_rs[i] - my) for i in range(n_pts))
    den = sum((log_sizes[i] - mx) ** 2 for i in range(n_pts)) or 1e-9
    return num / den


def _score_hurst(v: float) -> float:
    """Порт ilScoreHurst: >0.6 персистентный тренд (+1), <0.4 mean-reversion (-1)."""
    if v > 0.6:
        return 1.0
    if v < 0.4:
        return -1.0
    return 0.0


def pfe(closes: list[float], period: int = 10) -> float:
    """Polarized Fractal Efficiency ∈[-100,100]: знак — направление, величина — эффективность пути."""
    n = len(closes)
    if n <= period:
        return 0.0
    window = closes[-(period + 1):]
    price_change = window[-1] - window[0]
    path = sum(((window[j] - window[j - 1]) ** 2 + 1) ** 0.5 for j in range(1, len(window)))
    dist = (price_change ** 2 + period ** 2) ** 0.5
    if path <= 0:
        return 0.0
    sign = 1 if price_change >= 0 else -1
    return sign * 100 * dist / path


def _score_pfe(v: float) -> float:
    """Порт ilScorePFE."""
    if v > 50:
        return 1.0
    if v > 20:
        return 0.5
    if v < -50:
        return -1.0
    if v < -20:
        return -0.5
    return 0.0


def shannon_entropy(closes: list[float], window: int = 30, bins: int = 10) -> float:
    """∈[0, log2(bins)]: 0 — порядок (предсказуемо), max — шум (равновероятные бины)."""
    chunk = closes[-(window + 1):]
    if len(chunk) < 5:
        return 0.0
    rets = [math.log(chunk[i] / chunk[i - 1]) for i in range(1, len(chunk)) if chunk[i - 1] > 0 and chunk[i] > 0]
    if len(rets) < 5:
        return 0.0
    lo, hi = min(rets), max(rets)
    rng = (hi - lo) or 1e-9
    counts = [0] * bins
    for r in rets:
        idx = min(bins - 1, int((r - lo) / rng * bins))
        counts[idx] += 1
    total = sum(counts) or 1
    h = 0.0
    for c in counts:
        if c > 0:
            p = c / total
            h -= p * math.log2(p)
    return h


def permutation_entropy(closes: list[float], window: int = 30, m: int = 3) -> float:
    """∈[0,1] нормированная: 0 — единственный паттерн (предсказуемо), 1 — все паттерны равновероятны."""
    chunk = closes[-window:]
    if len(chunk) < m + 5:
        return 0.5
    pattern_counts: dict[tuple, int] = {}
    total = 0
    for j in range(len(chunk) - m + 1):
        sub = chunk[j:j + m]
        order = tuple(sorted(range(m), key=lambda k: sub[k]))
        pattern_counts[order] = pattern_counts.get(order, 0) + 1
        total += 1
    if total == 0:
        return 0.5
    h = 0.0
    for c in pattern_counts.values():
        p = c / total
        h -= p * math.log2(p)
    max_h = math.log2(math.factorial(m))
    return h / max_h if max_h > 0 else 0.5


def score_fractal(closes: list[float]) -> float:
    """
    Направление берётся только из PFE (единственный из трёх, у кого знак
    привязан к направлению цены — FDI и Hurst измеряют лишь "качество"
    тренда и одинаково положительны на любом сильном движении, что вверх,
    что вниз). FDI/Hurst участвуют только как множитель уверенности к
    знаку PFE, а не как равноправные направленные голоса — иначе на
    чистом сильном даунтренде FDI=+1, Hurst=+1 утягивали бы итог в LONG
    несмотря на отрицательный PFE.
    """
    if len(closes) < 15:
        return 0.0
    s_fdi = _score_fdi(fdi(closes, period=min(30, len(closes) - 1)))
    s_hurst = _score_hurst(hurst_exponent(closes, min_window=min(8, len(closes) // 4) or 1))
    s_pfe = _score_pfe(pfe(closes, period=min(10, len(closes) - 1)))
    trend_confidence = max(0.0, (s_fdi + s_hurst) / 2)
    return max(-1.0, min(1.0, s_pfe * (0.5 + 0.5 * trend_confidence)))


def choppiness_index(highs: list[float], lows: list[float], closes: list[float],
                     period: int = 14) -> list[float]:
    """
    Choppiness Index (Dreiss, 1993). Шкала 0–100.
    >61.8 — хаотичный рынок (боковик), <38.2 — трендовый.
    Возвращает ряд значений по всей длине входных данных.
    """
    n = len(closes)
    result = [50.0] * n
    if n < period + 1:
        return result
    # True Range
    tr = [0.0] * n
    tr[0] = highs[0] - lows[0]
    for i in range(1, n):
        tr[i] = max(highs[i] - lows[i],
                    abs(highs[i] - closes[i - 1]),
                    abs(lows[i] - closes[i - 1]))
    log_period = math.log10(period)
    for i in range(period, n):
        atr_sum = sum(tr[i - period + 1:i + 1])
        hi_p = max(highs[i - period + 1:i + 1])
        lo_p = min(lows[i - period + 1:i + 1])
        rng = hi_p - lo_p
        if rng <= 0 or atr_sum <= 0:
            result[i] = result[i - 1]
            continue
        result[i] = 100.0 * math.log10(atr_sum / rng) / log_period
    return result


def efficiency_ratio(closes: list[float], period: int = 14) -> list[float]:
    """
    Efficiency Ratio (Kaufman, 1995). Шкала 0–1.
    1.0 — цена шла строго в одну сторону, 0.0 — металась без прогресса.
    Используется для подтверждения смены режима совместно с Choppiness.
    """
    n = len(closes)
    result = [0.5] * n
    for i in range(period, n):
        window = closes[i - period:i + 1]
        direction = abs(window[-1] - window[0])
        volatility = sum(abs(window[j] - window[j - 1]) for j in range(1, len(window)))
        result[i] = direction / volatility if volatility > 0 else 0.5
    return result


def chop_energy_mult(highs: list[float], lows: list[float], closes: list[float],
                     period: int = 14,
                     chop_threshold: float = 61.8,
                     trend_threshold: float = 38.2) -> float:
    """
    Множитель тейк-профита от «накопленной энергии хаоса».

    Логика (по описанию пользователя):
    1. Считаем как долго Choppiness Index был выше порога перед текущим баром.
    2. Скорость перехода: резкое падение индекса = агрессивный слом режима.
    3. Подтверждение ER: оба показывают переход → множитель выше.
    4. Если жёсткость ниже нормы → коэф 0.8 (каскад слабее обычного).

    Возвращает float [0.7 .. 2.0] для масштабирования take_dist.
    """
    n = len(closes)
    if n < period * 3:
        return 1.0

    ci = choppiness_index(highs, lows, closes, period)
    er = efficiency_ratio(closes, period)

    # Текущее значение
    ci_now = ci[-1]
    er_now = er[-1]

    # Не в момент перехода — нейтрально
    if ci_now > 50:
        return 1.0   # рынок всё ещё хаотичен, не входить или обычные тейки

    # Считаем длительность предшествующей жёсткости (сколько баров ci > chop_threshold)
    chop_bars = 0
    for i in range(n - 2, max(0, n - 120), -1):
        if ci[i] > chop_threshold:
            chop_bars += 1
        else:
            break

    # Нормируем на «типичную» жёсткость: медиана серий выше порога за всю историю
    # Упрощение: берём 6 баров как «норму» (пользователь: 3-5 дней = норма)
    norm_bars = 6.0

    # Скорость падения индекса за последние 3 бара
    look_back = min(3, n - 1)
    ci_prev = ci[-1 - look_back]
    drop_speed = (ci_prev - ci_now) / (look_back or 1)   # >0 = падает, быстро = >10/бар

    # Коэффициент от длительности хаоса
    if chop_bars < norm_bars * 0.7:
        duration_k = 0.80   # ниже нормы — каскад слабее
    elif chop_bars < norm_bars * 1.5:
        duration_k = 1.00   # норма
    elif chop_bars < norm_bars * 2.5:
        duration_k = 1.30
    elif chop_bars < norm_bars * 4.0:
        duration_k = 1.60
    else:
        duration_k = 2.00   # очень долгий боковик → максимальная энергия

    # Коэффициент от скорости перехода
    if drop_speed > 15:
        speed_k = 1.20   # резкий слом режима
    elif drop_speed > 7:
        speed_k = 1.10
    else:
        speed_k = 1.00

    # ER подтверждение
    er_k = 1.10 if er_now > 0.50 else 1.00

    result = duration_k * speed_k * er_k
    return max(0.70, min(2.00, result))


def score_entropy_regime(closes: list[float]) -> float:
    """
    Низкая перестановочная энтропия (предсказуемое движение) усиливает текущее
    направление тренда; высокая (шум) гасит сигнал почти до нуля.
    """
    if len(closes) < 15:
        return 0.0
    pe = permutation_entropy(closes, window=min(30, len(closes)))
    direction = 1.0 if closes[-1] > closes[0] else (-1.0 if closes[-1] < closes[0] else 0.0)
    confidence = max(0.0, 1.0 - pe)
    return max(-1.0, min(1.0, direction * confidence))
