"""
Kalman Filter для финансовых временных рядов
Отвечает на вопрос: каков скрытый тренд и насколько шумны наблюдения?

Модель: Local Level Model (случайное блуждание + шум наблюдений)
  x_t = x_{t-1} + w_t,   w_t ~ N(0, Q)   — скрытый тренд (уравнение перехода)
  y_t = x_t + v_t,        v_t ~ N(0, R)   — наблюдаемая цена (уравнение наблюдения)

Q — дисперсия процесса: насколько быстро дрейфует тренд
R — дисперсия наблюдений: насколько зашумлены данные

Signal-to-Noise Ratio (SNR) = Q / R:
  SNR высокий → фильтр доверяет наблюдениям, следует за ценой
  SNR низкий  → фильтр игнорирует шум, выдаёт гладкий тренд

Опционально: адаптивная оценка Q и R через EM-алгоритм (онлайн-версия).
"""

import numpy as np
from dataclasses import dataclass
from typing import Optional


# ---------------------------------------------------------------------------
# Результат одного шага фильтрации
# ---------------------------------------------------------------------------

@dataclass
class KalmanResult:
    """
    Результат обработки одного наблюдения.

    trend          — апостериорная оценка скрытого тренда E[x_t | y_{1:t}]
    trend_std      — неопределённость тренда sqrt(P_t | y_{1:t})
    trend_upper    — trend + 2 * trend_std  (95% доверительный интервал)
    trend_lower    — trend - 2 * trend_std

    observation_noise_std  — текущая оценка std шума наблюдений sqrt(R)
    process_noise_std      — текущая оценка std процесса sqrt(Q)
    snr                    — Signal-to-Noise Ratio = Q / R

    innovation       — невязка: y_t - E[x_t | y_{1:t-1}]  (насколько цена удивила фильтр)
    innovation_std   — стандартизованная невязка (|innovation_std| > 2 → аномалия)

    kalman_gain      — K_t: вес, с которым фильтр обновляет тренд по новому наблюдению
                       K → 1: доверяем наблюдению; K → 0: доверяем прогнозу

    t                — номер шага
    """
    trend:                float
    trend_std:            float
    trend_upper:          float
    trend_lower:          float
    observation_noise_std: float
    process_noise_std:    float
    snr:                  float
    innovation:           float
    innovation_std:       float
    kalman_gain:          float
    t:                    int

    def __repr__(self) -> str:
        return (
            f"KalmanResult(t={self.t} "
            f"trend={self.trend:.5f} ±{self.trend_std:.5f} "
            f"K={self.kalman_gain:.4f} "
            f"SNR={self.snr:.4f} "
            f"inn_std={self.innovation_std:.2f})"
        )


# ---------------------------------------------------------------------------
# Основной фильтр
# ---------------------------------------------------------------------------

class KalmanFilter:
    """
    Kalman Filter: Local Level Model с опциональной адаптивной оценкой шумов.

    Параметры
    ----------
    R : float
        Начальная дисперсия шума наблюдений (var of observation noise).
        Для лог-цен: ~0.0001 – 0.01. Для лог-доходностей: ~1e-6 – 1e-4.
        Если adaptive=True — используется только как стартовое значение.

    Q : float
        Начальная дисперсия процесса (var of random walk step).
        Контролирует гладкость тренда. Меньше Q → более гладкий тренд.
        Типичное соотношение: Q ≈ R / 100 – R / 10.

    adaptive : bool
        Если True — Q и R обновляются онлайн через моменты инноваций
        (метод Мейера–Тейлора). Позволяет автоматически подстраиваться
        под изменение волатильности рынка.

    adaptive_window : int
        Размер скользящего окна для оценки моментов инноваций.
        Меньше → быстрее реагирует, но нестабильнее.

    init_state : float, optional
        Начальное значение тренда. Если None — берётся из первого наблюдения.

    init_variance : float
        Начальная неопределённость тренда P_0.
        Большое значение → фильтр быстро сходится к данным в начале.

    Пример
    ------
    kf = KalmanFilter(R=0.001, Q=1e-5)
    for price in prices:
        result = kf.update(price)
        print(result.trend, result.snr)
    """

    def __init__(
        self,
        R: float = 1e-3,
        Q: float = 1e-5,
        adaptive: bool = False,
        adaptive_window: int = 50,
        init_state: Optional[float] = None,
        init_variance: float = 1.0,
    ):
        if R <= 0 or Q <= 0:
            raise ValueError("R и Q должны быть > 0")

        self._R = float(R)
        self._Q = float(Q)
        self.adaptive = adaptive
        self.adaptive_window = adaptive_window
        self._init_variance = float(init_variance)

        # Состояние фильтра
        self._x: Optional[float] = init_state   # апостериорный тренд
        self._P: float = init_variance            # апостериорная дисперсия тренда
        self._t: int = 0

        # Буфер инноваций для адаптивной оценки
        self._innovations: list = []
        self._inn_sq: list = []        # инновации² для оценки S = K²*R + Q
        self._last_K: float = 1.0
        self._last_F: float = init_variance + R   # innovation variance

    # ------------------------------------------------------------------
    # Публичный API
    # ------------------------------------------------------------------

    def update(self, y: float) -> KalmanResult:
        """
        Принять новое наблюдение y и вернуть отфильтрованное состояние.
        y — наблюдаемое значение (цена, лог-цена, лог-доходность и т.п.)
        """
        # Инициализация из первого наблюдения
        if self._x is None:
            self._x = y
            self._P = self._init_variance
            self._t += 1
            return KalmanResult(
                trend=y,
                trend_std=float(np.sqrt(self._P)),
                trend_upper=y + 2 * float(np.sqrt(self._P)),
                trend_lower=y - 2 * float(np.sqrt(self._P)),
                observation_noise_std=float(np.sqrt(self._R)),
                process_noise_std=float(np.sqrt(self._Q)),
                snr=self._Q / self._R,
                innovation=0.0,
                innovation_std=0.0,
                kalman_gain=1.0,
                t=self._t,
            )

        # --- Шаг предсказания (predict) ---
        x_pred = self._x                        # E[x_t | y_{1:t-1}]
        P_pred = self._P + self._Q              # Var[x_t | y_{1:t-1}]

        # --- Инновация ---
        inn = y - x_pred                        # y_t - E[x_t | y_{1:t-1}]
        F   = P_pred + self._R                  # дисперсия инновации S_t

        # --- Шаг обновления (update) ---
        K   = P_pred / F                        # Kalman gain
        x_post = x_pred + K * inn              # апостериорный тренд
        P_post = (1.0 - K) * P_pred            # апостериорная дисперсия (Joseph form)

        # Стандартизованная инновация
        inn_std = inn / np.sqrt(F) if F > 0 else 0.0

        # --- Сохраняем состояние ---
        self._x = x_post
        self._P = P_post
        self._last_K = K
        self._last_F = F
        self._t += 1

        # --- Адаптивное обновление Q и R ---
        if self.adaptive:
            self._adaptive_update(inn, K, F)

        trend_std = float(np.sqrt(max(P_post, 0.0)))
        return KalmanResult(
            trend=float(x_post),
            trend_std=trend_std,
            trend_upper=float(x_post) + 2.0 * trend_std,
            trend_lower=float(x_post) - 2.0 * trend_std,
            observation_noise_std=float(np.sqrt(self._R)),
            process_noise_std=float(np.sqrt(self._Q)),
            snr=self._Q / self._R,
            innovation=float(inn),
            innovation_std=float(inn_std),
            kalman_gain=float(K),
            t=self._t,
        )

    def batch(self, observations: np.ndarray) -> list:
        """
        Обработать массив наблюдений за один вызов.
        Возвращает список KalmanResult в том же порядке.
        """
        return [self.update(float(y)) for y in observations]

    def reset(self, init_state: Optional[float] = None):
        """Сбросить фильтр к начальному состоянию."""
        self._x = init_state
        self._P = self._init_variance
        self._t = 0
        self._innovations.clear()
        self._inn_sq.clear()
        self._last_K = 1.0

    @property
    def state(self) -> Optional[float]:
        """Текущая апостериорная оценка тренда."""
        return self._x

    @property
    def variance(self) -> float:
        """Текущая апостериорная дисперсия тренда."""
        return self._P

    @property
    def R(self) -> float:
        """Текущая оценка дисперсии шума наблюдений."""
        return self._R

    @property
    def Q(self) -> float:
        """Текущая оценка дисперсии процесса."""
        return self._Q

    # ------------------------------------------------------------------
    # Адаптивная оценка Q и R (метод моментов инноваций)
    # ------------------------------------------------------------------

    def _adaptive_update(self, inn: float, K: float, F: float) -> None:
        """
        Обновление Q и R через моменты инноваций.

        Теорема Меера (1973): при корректных Q и R выполняется
          E[inn_t²] = F_t  (дисперсия инновации)

        Из скользящих оценок inn² и F восстанавливаем Q и R.
        """
        win = self.adaptive_window
        self._innovations.append(inn)
        if len(self._innovations) > win:
            self._innovations.pop(0)

        if len(self._innovations) < max(10, win // 5):
            return

        inn_arr = np.array(self._innovations)
        inn_var = float(np.var(inn_arr))    # оценка E[inn²] - E[inn]²

        # R_new: из E[inn²] = R + Q / K (упрощённая аппроксимация при малом Q)
        # Более точно: E[inn²] = F = P_pred + R, а P_pred → Q / K при стационарности
        # Поэтому: R ≈ inn_var * (1 - K)
        R_new = max(inn_var * (1.0 - K), 1e-10)
        Q_new = max(inn_var * K * K, 1e-12)

        # Сглаживание экспоненциальным MA для стабильности
        alpha = 2.0 / (win + 1)
        self._R = (1.0 - alpha) * self._R + alpha * R_new
        self._Q = (1.0 - alpha) * self._Q + alpha * Q_new


# ---------------------------------------------------------------------------
# Обёртка для ценовых рядов: работает с ценами, не с доходностями
# ---------------------------------------------------------------------------

class MarketTrendFilter:
    """
    Kalman Filter для прямой подачи рыночных цен.

    Внутри работает с лог-ценами для лучших статистических свойств
    (мультипликативные шоки → аддитивные в лог-пространстве).

    Параметры
    ----------
    volatility_guess : float
        Ожидаемое дневное/минутное движение цены в долях (например, 0.01 = 1%).
        Используется для автоматического подбора R.

    trend_smoothness : float
        Относительная гладкость тренда: Q = R * trend_smoothness.
        0.001 → очень гладкий тренд (медленный).
        0.1   → тренд быстро следует за ценой.

    adaptive : bool
        Автоматически подстраивать Q и R под текущую волатильность.

    Пример
    ------
    f = MarketTrendFilter(volatility_guess=0.01, trend_smoothness=0.01)
    for price in prices:
        result = f.update(price)
        print(f"Тренд: {result.trend_price:.2f}, шум: {result.noise_pct:.3f}%")
    """

    def __init__(
        self,
        volatility_guess: float = 0.01,
        trend_smoothness: float = 0.01,
        adaptive: bool = True,
    ):
        R = volatility_guess ** 2
        Q = R * trend_smoothness
        self._kf = KalmanFilter(R=R, Q=Q, adaptive=adaptive)
        self._last_log_price: Optional[float] = None

    def update(self, price: float) -> Optional["MarketTrendResult"]:
        """
        Подать цену. Возвращает None для первого наблюдения.
        """
        if price <= 0:
            return None
        log_price = np.log(price)
        result = self._kf.update(log_price)
        trend_price = float(np.exp(result.trend))
        noise_pct = float(np.sqrt(result.observation_noise_std ** 2)) * 100.0
        return MarketTrendResult(
            trend_price=trend_price,
            trend_price_upper=float(np.exp(result.trend_upper)),
            trend_price_lower=float(np.exp(result.trend_lower)),
            noise_pct=result.observation_noise_std * 100.0,
            process_noise_pct=result.process_noise_std * 100.0,
            snr=result.snr,
            innovation=result.innovation,
            innovation_std=result.innovation_std,
            kalman_gain=result.kalman_gain,
            t=result.t,
        )

    def reset(self):
        self._kf.reset()
        self._last_log_price = None

    @property
    def kalman_filter(self) -> KalmanFilter:
        """Доступ к внутреннему KalmanFilter для инспекции."""
        return self._kf


@dataclass
class MarketTrendResult:
    """
    Результат MarketTrendFilter в ценовых единицах.

    trend_price        — сглаженная оценка истинной цены (скрытый тренд)
    trend_price_upper  — верхняя граница 95% доверительного интервала тренда
    trend_price_lower  — нижняя граница 95% доверительного интервала тренда
    noise_pct          — оценка std шума наблюдений в %% от цены
    process_noise_pct  — оценка std процессного шума в %% (скорость дрейфа тренда)
    snr                — Signal-to-Noise Ratio (Q/R): > 0.1 → рынок трендовый
    innovation         — невязка в лог-пространстве (лог-доходность минус прогноз)
    innovation_std     — стандартизованная невязка (|x| > 2 → нетипичное движение)
    kalman_gain        — вес нового наблюдения при обновлении тренда [0, 1]
    t                  — номер шага
    """
    trend_price:        float
    trend_price_upper:  float
    trend_price_lower:  float
    noise_pct:          float
    process_noise_pct:  float
    snr:                float
    innovation:         float
    innovation_std:     float
    kalman_gain:        float
    t:                  int

    def __repr__(self) -> str:
        return (
            f"MarketTrendResult(t={self.t} "
            f"trend={self.trend_price:.4f} "
            f"noise={self.noise_pct:.3f}% "
            f"SNR={self.snr:.5f} "
            f"K={self.kalman_gain:.4f})"
        )


# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    rng = np.random.default_rng(42)

    # Синтетический ценовой ряд: тренд + нарастающий шум + структурный сдвиг
    n = 400
    trend_true = np.cumsum(rng.normal(0.0002, 0.003, n)) + np.log(100.0)
    noise_low  = rng.normal(0, 0.005, 200)
    noise_high = rng.normal(0, 0.020, 200)   # шум удваивается в середине
    log_prices = trend_true + np.concatenate([noise_low, noise_high])
    prices = np.exp(log_prices)

    # --- Тест 1: фиксированные параметры ---
    print("=== KalmanFilter (фиксированный, лог-цены) ===")
    kf = KalmanFilter(R=2.5e-5, Q=9e-6)
    print(f"{'t':>5}  {'trend':>10}  {'±std':>8}  {'K':>6}  {'inn_std':>8}  {'SNR':>8}")
    print("-" * 60)
    results = kf.batch(log_prices)
    for i in [0, 50, 100, 150, 199, 200, 210, 250, 300, 399]:
        r = results[i]
        print(
            f"{r.t:>5}  {r.trend:>10.5f}  {r.trend_std:>8.5f}"
            f"  {r.kalman_gain:>6.4f}  {r.innovation_std:>8.3f}  {r.snr:>8.5f}"
        )

    print()
    print("=== MarketTrendFilter (адаптивный, цены) ===")
    mf = MarketTrendFilter(volatility_guess=0.01, trend_smoothness=0.01, adaptive=True)
    print(f"{'t':>5}  {'trend_price':>12}  {'noise%':>8}  {'SNR':>8}  {'K':>6}  {'inn_std':>8}")
    print("-" * 65)
    for i, p in enumerate(prices):
        r = mf.update(p)
        if r and i in [0, 50, 100, 150, 199, 200, 210, 250, 300, 399]:
            print(
                f"{r.t:>5}  {r.trend_price:>12.4f}  {r.noise_pct:>8.4f}"
                f"  {r.snr:>8.5f}  {r.kalman_gain:>6.4f}  {r.innovation_std:>8.3f}"
            )

    print()
    print("noise_pct должен вырасти после t=200 (переход к высокой волатильности)")
