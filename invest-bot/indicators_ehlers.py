"""
indicators_ehlers.py — Эрлерс DSP-индикаторы.

Блок 1 (старый): Cyber Cycle, Roofing Filter, Decycler, Fisher RSI, EBSW.
Блок 2 (новый): полноценный Эрлерс —
  - mama_fama()          : MESA Adaptive MA / Following Adaptive MA через
                           мгновенную фазу Хилберта. Определяет когда рынок
                           переходит из цикличного в трендовый режим.
  - dominant_cycle()     : доминантный период через хомодинный дискриминатор
                           (Cybernetic Analysis, 2004). Длина цикла в барах.
  - cyber_cycle_phase()  : Cyber Cycle с фазой и скоростью вместо знака.
  - score_mama_fama()    : скорость и направление разрыва MAMA/FAMA.
  - score_ehlers_mode()  : детектор режима цикл→тренд (точка входа).
  - score_cyber_phase()  : позиция в цикле + скорость (≠ пересечение нуля).
"""
import math

__all__ = (
    "cyber_cycle", "roofing_filter", "decycler_oscillator", "rsi", "fisher_rsi",
    "even_better_sinewave", "score_cyber_cycle", "score_decycler",
    "score_fisher_rsi", "score_ebsw",
    # Блок 2
    "mama_fama", "dominant_cycle", "cyber_cycle_phase",
    "score_mama_fama", "score_ehlers_mode", "score_cyber_phase",
)


def cyber_cycle(closes: list[float], alpha: float = 0.07) -> list[float]:
    n = len(closes)
    if n < 4:
        return [0.0] * n
    smooth = [0.0] * n
    cycle = [0.0] * n
    for i in range(3, n):
        smooth[i] = (closes[i] + 2 * closes[i - 1] + 2 * closes[i - 2] + closes[i - 3]) / 6
    for i in range(3, n):
        if i < 5:
            cycle[i] = (closes[i] - 2 * closes[i - 1] + closes[i - 2]) / 4 if i >= 2 else 0.0
            continue
        cycle[i] = ((1 - 0.5 * alpha) ** 2) * (smooth[i] - 2 * smooth[i - 1] + smooth[i - 2]) \
            + 2 * (1 - alpha) * cycle[i - 1] - ((1 - alpha) ** 2) * cycle[i - 2]
    return cycle


def _score_cross(series: list[float]) -> float:
    """Порт ilScoreCyberCycleInd: пересечение нуля -> +-1, иначе знак -> +-0.5."""
    if len(series) < 2:
        return 0.0
    v, prev = series[-1], series[-2]
    if v > 0 and prev < 0:
        return 1.0
    if v < 0 and prev > 0:
        return -1.0
    if v > 0:
        return 0.5
    if v < 0:
        return -0.5
    return 0.0


def roofing_filter(closes: list[float], hp_period: int = 48, lp_period: int = 10) -> list[float]:
    n = len(closes)
    if n < 3:
        return [0.0] * n
    alpha1 = (math.cos(2 * math.pi / hp_period) + math.sin(2 * math.pi / hp_period) - 1) / math.cos(2 * math.pi / hp_period)
    hp = [0.0] * n
    for i in range(2, n):
        hp[i] = ((1 - alpha1 / 2) ** 2) * (closes[i] - 2 * closes[i - 1] + closes[i - 2]) \
            + 2 * (1 - alpha1) * hp[i - 1] - ((1 - alpha1) ** 2) * hp[i - 2]
    a = math.exp(-1.414 * math.pi / lp_period)
    b = 2 * a * math.cos(1.414 * math.pi / lp_period)
    c2, c3 = b, -a * a
    c1 = 1 - c2 - c3
    out = [0.0] * n
    for i in range(2, n):
        out[i] = c1 * (hp[i] + hp[i - 1]) / 2 + c2 * out[i - 1] + c3 * out[i - 2]
    return out


def decycler_oscillator(closes: list[float], hp_period: int = 125) -> list[float]:
    n = len(closes)
    if n < 2:
        return [0.0] * n
    alpha1 = (math.cos(2 * math.pi / hp_period) + math.sin(2 * math.pi / hp_period) - 1) / math.cos(2 * math.pi / hp_period)
    decycler = [closes[0]] + [0.0] * (n - 1)
    for i in range(1, n):
        decycler[i] = (alpha1 / 2) * (closes[i] + closes[i - 1]) + (1 - alpha1) * decycler[i - 1]
    return [closes[i] - decycler[i] for i in range(n)]


def _score_sign_half(v: float) -> float:
    """Порт ilScoreDecyclerInd."""
    return 0.5 if v > 0 else -0.5


def rsi(closes: list[float], period: int = 14) -> list[float]:
    n = len(closes)
    if n <= period:
        return [50.0] * n
    out = [50.0] * (period + 1)
    gains = [max(0.0, closes[i] - closes[i - 1]) for i in range(1, period + 1)]
    losses = [max(0.0, closes[i - 1] - closes[i]) for i in range(1, period + 1)]
    avg_gain, avg_loss = sum(gains) / period, sum(losses) / period
    rs0 = avg_gain / avg_loss if avg_loss > 0 else 100.0
    out[period] = 100 - 100 / (1 + rs0) if avg_loss > 0 else 100.0
    for i in range(period + 1, n):
        change = closes[i] - closes[i - 1]
        gain, loss = max(0.0, change), max(0.0, -change)
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        rs = avg_gain / avg_loss if avg_loss > 0 else 100.0
        out.append(100 - 100 / (1 + rs) if avg_loss > 0 else 100.0)
    return out


def fisher_rsi(closes: list[float], period: int = 10) -> list[float]:
    rsi_vals = rsi(closes, period)
    out = []
    for v in rsi_vals:
        x = max(-0.999, min(0.999, v / 100 * 2 - 1))
        out.append(0.5 * math.log((1 + x) / (1 - x)))
    return out


def _score_fisher(v: float) -> float:
    """Порт ilScoreFisher, нормировано из [-2,2] в [-1,1]."""
    if v > 1.5:
        return 1.0
    if v > 0.5:
        return 0.5
    if v < -1.5:
        return -1.0
    if v < -0.5:
        return -0.5
    return 0.0


def even_better_sinewave(closes: list[float], hp_period: int = 40, period: int = 10) -> list[float]:
    hp = roofing_filter(closes, hp_period, period)
    n = len(hp)
    out = [0.0] * n
    for i in range(period - 1, n):
        window = hp[i - period + 1:i + 1]
        rms = (sum(x * x for x in window) / len(window)) ** 0.5 or 1.0
        out[i] = hp[i] / rms
    return out


def score_cyber_cycle(closes: list[float]) -> float:
    if len(closes) < 10:
        return 0.0
    return _score_cross(cyber_cycle(closes))


def score_decycler(closes: list[float]) -> float:
    if len(closes) < 10:
        return 0.0
    return _score_sign_half(decycler_oscillator(closes, hp_period=min(125, max(10, len(closes))))[-1])


def score_fisher_rsi(closes: list[float]) -> float:
    if len(closes) < 12:
        return 0.0
    return _score_fisher(fisher_rsi(closes, period=min(10, len(closes) - 1))[-1])


def score_ebsw(closes: list[float]) -> float:
    if len(closes) < 15:
        return 0.0
    period = min(10, max(3, len(closes) // 3))
    series = even_better_sinewave(closes, hp_period=min(40, len(closes)), period=period)
    return _score_cross(series)


# ── Блок 2: полный Эрлерс ────────────────────────────────────────────────────

def mama_fama(closes: list[float],
              fast_limit: float = 0.5,
              slow_limit: float = 0.05) -> tuple[list[float], list[float], list[float]]:
    """
    MAMA (MESA Adaptive Moving Average) и FAMA (Following Adaptive MA).
    Источник: J.Ehlers «Cybernetic Analysis for Stocks and Futures», 2004, гл.12.

    Алгоритм:
    1. Хилберт-трансформ (упрощённый 4-барный) → мгновенная фаза.
    2. Скорость изменения фазы → адаптивный alpha (быстрее фаза — меньше lag).
    3. MAMA = адаптивная EMA; FAMA = ещё медленнее (alpha/2).

    Возвращает (mama, fama, smooth_period) — три ряда той же длины что closes.
    smooth_period — сглаженный доминантный период в барах (6..50).

    Интерпретация:
    - MAMA выше FAMA → бычий режим (и наоборот).
    - Скорость разрыва = насколько быстро рынок перешёл в тренд.
    - Пересечение MAMA/FAMA = смена режима.
    """
    n = len(closes)
    nan = float('nan')
    mama_s  = [nan] * n
    fama_s  = [nan] * n
    period_s = [nan] * n

    if n < 10:
        return mama_s, fama_s, period_s

    smooth  = [0.0] * n
    detrender = [0.0] * n
    i1 = [0.0] * n
    q1 = [0.0] * n
    ji = [0.0] * n
    jq = [0.0] * n
    i2 = [0.0] * n
    q2 = [0.0] * n
    re = [0.0] * n
    im = [0.0] * n
    period  = [0.0] * n
    smooth_period = [0.0] * n
    phase   = [0.0] * n
    mama_v  = closes[0]
    fama_v  = closes[0]

    for i in range(n):
        if i >= 3:
            smooth[i] = (4 * closes[i] + 3 * closes[i-1] + 2 * closes[i-2] + closes[i-3]) / 10.0

        if i < 6:
            mama_s[i] = closes[i]
            fama_s[i] = closes[i]
            period_s[i] = 10.0
            continue

        sp = smooth_period[i-1] if i > 0 else 10.0
        adj = 0.075 * sp + 0.54

        detrender[i] = (0.0962*smooth[i] + 0.5769*smooth[i-2]
                        - 0.5769*smooth[i-4] - 0.0962*smooth[i-6]) * adj

        q1[i] = (0.0962*detrender[i] + 0.5769*detrender[i-2]
                 - 0.5769*detrender[i-4] - 0.0962*detrender[i-6]) * adj
        i1[i] = detrender[i-3] if i >= 3 else 0.0

        ji_v = (0.0962*i1[i] + 0.5769*i1[i-2]
                - 0.5769*i1[i-4] - 0.0962*i1[i-6]) * adj if i >= 6 else 0.0
        jq_v = (0.0962*q1[i] + 0.5769*q1[i-2]
                - 0.5769*q1[i-4] - 0.0962*q1[i-6]) * adj if i >= 6 else 0.0
        ji[i] = ji_v; jq[i] = jq_v

        i2_raw = i1[i] - jq[i]
        q2_raw = q1[i] + ji[i]
        i2[i] = 0.2 * i2_raw + 0.8 * i2[i-1]
        q2[i] = 0.2 * q2_raw + 0.8 * q2[i-1]

        re_raw = i2[i] * i2[i-1] + q2[i] * q2[i-1]
        im_raw = i2[i] * q2[i-1] - q2[i] * i2[i-1]
        re[i] = 0.2 * re_raw + 0.8 * re[i-1]
        im[i] = 0.2 * im_raw + 0.8 * im[i-1]

        if re[i] != 0 and im[i] != 0:
            raw_period = 2 * math.pi / math.atan(im[i] / re[i])
        else:
            raw_period = period[i-1] if i > 0 else 10.0

        # Ограничиваем изменение периода за один бар: не более ±50%
        prev_p = period[i-1] if i > 0 else 10.0
        raw_period = max(0.67 * prev_p, min(1.5 * prev_p, raw_period))
        period[i] = max(6.0, min(50.0, raw_period))
        smooth_period[i] = 0.2 * period[i] + 0.8 * (smooth_period[i-1] if i > 0 else period[i])

        if i1[i] != 0:
            phase[i] = math.atan(q1[i] / i1[i]) * (180.0 / math.pi)
        else:
            phase[i] = phase[i-1] if i > 0 else 0.0

        delta_phase = max(1.0, (phase[i-1] if i > 0 else 0.0) - phase[i])
        alpha = max(slow_limit, min(fast_limit, fast_limit / delta_phase))

        mama_v = alpha * closes[i] + (1.0 - alpha) * mama_v
        fama_v = 0.5 * alpha * mama_v + (1.0 - 0.5 * alpha) * fama_v
        mama_s[i]  = mama_v
        fama_s[i]  = fama_v
        period_s[i] = smooth_period[i]

    return mama_s, fama_s, period_s


def dominant_cycle(closes: list[float]) -> list[float]:
    """
    Доминантный период цикла через хомодинный дискриминатор (Эрлерс 2004).
    Возвращает ряд сглаженных периодов в барах (6..50).
    Это third output из mama_fama — отдельная функция для удобства.
    """
    _, _, period_s = mama_fama(closes)
    return period_s


def cyber_cycle_phase(closes: list[float], alpha: float = 0.07
                      ) -> tuple[list[float], list[float], list[float]]:
    """
    Cyber Cycle с вычислением мгновенной фазы и скорости.

    Возвращает (cycle, phase_deg, phase_speed):
    - cycle      : сам осциллятор (как раньше)
    - phase_deg  : фаза в градусах (0=дно, 90=середина роста, 180=пик, 270=середина падения)
    - phase_speed: скорость изменения фазы (градусов/бар). Высокая = сильный импульс.
    """
    cy = cyber_cycle(closes, alpha)
    n = len(cy)
    phase_deg   = [0.0] * n
    phase_speed = [0.0] * n

    for i in range(1, n):
        c  = cy[i]
        pc = cy[i-1]
        # Мгновенная фаза через atan2 цикла и его производной
        dc = c - pc   # первая производная ≈ квадратурная компонента
        angle = math.atan2(dc, c) * (180.0 / math.pi)
        # Нормируем в [0, 360]
        phase_deg[i] = angle % 360.0
        # Скорость: изменение угла (с учётом перехода через 0/360)
        diff = phase_deg[i] - phase_deg[i-1]
        if diff < -180: diff += 360
        if diff >  180: diff -= 360
        phase_speed[i] = diff

    return cy, phase_deg, phase_speed


# ── Score-функции блока 2 ─────────────────────────────────────────────────────

def score_mama_fama(closes: list[float]) -> float:
    """
    MAMA_FAMA: скорость и направление разрыва между MAMA и FAMA.

    Возвращает:
    - ±0.25 если MAMA > FAMA (бычий режим) / MAMA < FAMA (медвежий)
    - ±0.55 если разрыв резко нарастает (переход цикл→тренд, начало каскада)
    - ±0.80 при пересечении (смена режима) + нарастающем разрыве
    - 0.0   если разрыв стабилен или сжимается (цикличный режим)
    """
    if len(closes) < 20:
        return 0.0
    mama_s, fama_s, _ = mama_fama(closes)

    # Последние валидные значения
    def _last(arr, k=1):
        vals = [v for v in arr if not (isinstance(v, float) and math.isnan(v))]
        return vals[-k] if len(vals) >= k else 0.0

    m1 = _last(mama_s, 1); f1 = _last(fama_s, 1)
    m2 = _last(mama_s, 2); f2 = _last(fama_s, 2)
    m5 = _last(mama_s, 5); f5 = _last(fama_s, 5)

    if m1 == 0 and f1 == 0:
        return 0.0

    price_ref = abs(m1) or 1.0
    gap_now  = (m1 - f1) / price_ref
    gap_prev = (m2 - f2) / price_ref
    gap_5ago = (m5 - f5) / price_ref

    direction = 1 if gap_now > 0 else -1

    # Пересечение (смена режима)
    crossing = (gap_now > 0) != (gap_prev > 0)

    # Скорость нарастания разрыва
    gap_speed = abs(gap_now) - abs(gap_5ago)  # >0 = разрыв растёт

    if crossing and gap_speed > 0:
        # Только что сменился режим И разрыв нарастает → каскад начинается
        strength = min(0.80, 0.55 + min(1.0, gap_speed * 200) * 0.25)
        return round(direction * strength, 4)

    if not crossing and gap_speed > 0.0005:
        # Разрыв нарастает в том же направлении → тренд усиливается
        strength = min(0.55, 0.25 + min(1.0, gap_speed * 150) * 0.30)
        return round(direction * strength, 4)

    if abs(gap_now) > 0.001:
        # Стабильный разрыв → тренд есть, но без ускорения
        return round(direction * 0.20, 4)

    return 0.0


def score_ehlers_mode(closes: list[float]) -> float:
    """
    EHLERS_MODE: детектор режима рынка — цикличный vs трендовый.

    Логика Эрлерса: сравниваем RMS цены с RMS Cyber Cycle за одно окно.
    Если цена «живёт» в цикле (Cyber Cycle объясняет большую часть движения)
    → цикличный режим, каскада нет. Если цена ушла далеко за пределы цикла
    → трендовый режим, началось направленное движение.

    Дополнительно: стабильность доминантного периода.
    Резкое изменение периода = сигнал смены режима.

    Возвращает:
    -  0.0 ..  0.0  в цикличном режиме (молчим — нет каскада)
    - ±0.30 .. ±0.65 в трендовом режиме (усиливаем сигнал в сторону тренда)
    """
    if len(closes) < 25:
        return 0.0

    cy, _, phase_spd = cyber_cycle_phase(closes)
    _, _, period_s = mama_fama(closes)

    # RMS цены (нормированная) vs RMS цикла за последние 20 баров
    win = closes[-20:]
    cy_win = [v for v in cy[-20:] if not math.isnan(v)]
    if not cy_win:
        return 0.0

    price_mean = sum(win) / len(win)
    rms_price = math.sqrt(sum((v - price_mean) ** 2 for v in win) / len(win)) or 1e-9
    rms_cycle = math.sqrt(sum(v ** 2 for v in cy_win) / len(cy_win))

    snr = rms_cycle / rms_price   # <0.3 = тренд доминирует; >0.7 = цикл доминирует

    # Стабильность периода: std периода за последние 10 валидных значений
    p_vals = [v for v in period_s if not (isinstance(v, float) and math.isnan(v))]
    if len(p_vals) >= 5:
        p_win = p_vals[-10:]
        p_mean = sum(p_win) / len(p_win)
        p_std  = math.sqrt(sum((v - p_mean) ** 2 for v in p_win) / len(p_win))
        period_unstable = p_std > 5.0   # период скачет → режим меняется
    else:
        period_unstable = False

    # Скорость фазы: высокая = сильный импульс
    spd_vals = [v for v in phase_spd[-10:] if v != 0]
    avg_phase_speed = sum(abs(v) for v in spd_vals) / len(spd_vals) if spd_vals else 0.0

    # Цикличный режим: SNR высокий, период стабилен, фаза медленная
    if snr > 0.65 and not period_unstable:
        return 0.0   # рынок в цикле, каскада нет, молчим

    # Трендовый / переходный режим
    price_dir = 1 if closes[-1] > closes[-5] else -1
    trend_strength = min(1.0, (1.0 - snr) / 0.7)       # 0..1 при snr 0..0.3
    phase_boost    = min(0.25, avg_phase_speed / 30.0)  # быстрая фаза = каскад
    instab_boost   = 0.15 if period_unstable else 0.0

    score = trend_strength * 0.40 + phase_boost + instab_boost
    return round(price_dir * min(0.65, score), 4)


def score_cyber_phase(closes: list[float]) -> float:
    """
    CYBER_PHASE: позиция в цикле + скорость, а не просто пересечение нуля.

    Пересечение нуля (старый метод) даёт сигнал с запозданием ~четверть цикла.
    Фаза в градусах позволяет:
    - Видеть НАЧАЛО цикла роста (фаза ~270°→360°/0°) до пересечения нуля.
    - Измерять скорость: высокая скорость фазы = сильный импульс.
    - Отличать вялый цикл от импульсного (каскад vs боковик).

    Возвращает:
    - ±0.60..±0.90 в начале фазы с высокой скоростью (каскад подтверждён)
    - ±0.30..±0.55 в начале фазы с умеренной скоростью
    - ±0.15..±0.30 в середине фазы
    - ≈0.0 на пике/дне (где Эрлерс обычно давал старый ±1 с запозданием)
    """
    if len(closes) < 15:
        return 0.0

    cy, phase_deg, phase_spd = cyber_cycle_phase(closes)
    ph  = phase_deg[-1]
    spd = phase_spd[-1]

    # Скорость фазы: нормируем. Нормальная скорость цикла ~360/period ≈ 10-20°/бар.
    # Высокая (>25°/бар) = сильный импульс; низкая (<5°/бар) = вялый рынок.
    speed_score = min(1.0, abs(spd) / 25.0)

    # Позиция в цикле
    # 270°-360°/0° = начало роста (максимально бычья фаза)
    # 0°-90°       = продолжение роста
    # 90°-180°     = замедление (пик)
    # 180°-270°    = начало падения (медвежья фаза)
    if 270 <= ph <= 360 or 0 <= ph < 45:
        # Начало бычьей фазы
        base = 0.45 + speed_score * 0.45
        return round(min(0.90, base), 4)
    elif 45 <= ph < 90:
        # Продолжение роста, momentum сохраняется
        return round(0.25 + speed_score * 0.30, 4)
    elif 90 <= ph < 135:
        # Замедление у пика
        return round(speed_score * 0.15, 4)
    elif 135 <= ph < 180:
        # Пик, разворот вниз начинается
        return round(-speed_score * 0.20, 4)
    elif 180 <= ph < 225:
        # Начало медвежьей фазы
        base = -(0.45 + speed_score * 0.45)
        return round(max(-0.90, base), 4)
    elif 225 <= ph < 270:
        # Продолжение падения
        return round(-(0.25 + speed_score * 0.30), 4)
    return 0.0
