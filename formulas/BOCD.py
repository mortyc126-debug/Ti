"""
Bayesian Online Change Point Detection (BOCD)
Based on: Adams & MacKay (2007) "Bayesian Online Changepoint Detection"

Отвечает на вопрос: "Рынок сейчас такой же, как минуту/день назад, или уже переключился?"

Модель Normal-Inverse-Gamma — сопряжённый prior для нормального распределения
с неизвестными mean и variance. Стандартный выбор для финансовых временных рядов.

Математика:
  - Каждая гипотеза = "текущий режим длится r шагов".
  - Апостериорное распределение P(r_t | x_{1:t}) обновляется рекурсивно.
  - Смена режима обнаруживается когда основная масса вероятности
    сосредотачивается на коротких run lengths (rl_mode << t).
"""

import numpy as np
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Вспомогательная функция: log-gamma без scipy (Lanczos approximation)
# ---------------------------------------------------------------------------

_LANCZOS_G = 7
_LANCZOS_C = np.array([
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
])


def _log_gamma(x: float) -> float:
    """Log Gamma function via Lanczos approximation. Accurate to ~1e-13."""
    if x < 0.5:
        return np.log(np.pi / np.sin(np.pi * x)) - _log_gamma(1.0 - x)
    x -= 1.0
    a = _LANCZOS_C[0]
    for i in range(1, _LANCZOS_G + 2):
        a += _LANCZOS_C[i] / (x + i)
    t = x + _LANCZOS_G + 0.5
    return 0.5 * np.log(2 * np.pi) + (x + 0.5) * np.log(t) - t + np.log(a)


# ---------------------------------------------------------------------------
# Параметры модели
# ---------------------------------------------------------------------------

@dataclass
class NIGParams:
    """
    Параметры Normal-Inverse-Gamma распределения.

    Кодирует апостериорные знания о среднем (mu) и дисперсии текущего режима.
      mu    — центр prior/posterior на mean
      kappa — уверенность в mu (виртуальных наблюдений)
      alpha — shape для precision (связан с числом наблюдений)
      beta  — scale для precision (связан с накопленным sum of squares)
    """
    mu: float = 0.0
    kappa: float = 1.0
    alpha: float = 2.0
    beta: float = 1e-4


# ---------------------------------------------------------------------------
# Ядро алгоритма
# ---------------------------------------------------------------------------

class BOCD:
    """
    Bayesian Online Change Point Detector.

    Параметры
    ----------
    hazard_rate : float
        Ожидаемая частота смены режима = 1 / (средняя длина режима).
        Внутридневные данные: 1/100 – 1/500.
        Дневные данные:       1/20  – 1/100.

    prior : NIGParams
        Prior на параметры каждого нового режима.
        beta ≈ ожидаемая дисперсия режима (var of returns):
          - минутные лог-доходности: ~1e-6 – 1e-5
          - дневные лог-доходности:  ~1e-4 – 1e-3

    change_threshold : float
        run_length_mode / t < change_threshold → флаг смены режима.
        Диапазон (0, 1). Меньше = консервативнее (меньше ложных срабатываний).
        Рекомендовано: 0.1 – 0.3.

    max_run_length : int
        Максимальное число хранимых гипотез о длине режима.
        Обрезание ускоряет работу без потери точности.

    Пример использования
    --------------------
    detector = BOCD(hazard_rate=1/200, prior=NIGParams(beta=1e-6))
    for price in prices:
        result = detector.update(price)   # подаётся лог-доходность!
        if result.regime_changed:
            print(f"Смена режима! rl={result.run_length_mode}")
    """

    def __init__(
        self,
        hazard_rate: float = 1 / 200,
        prior: Optional[NIGParams] = None,
        change_threshold: float = 0.15,
        max_run_length: int = 1000,
    ):
        if not (0 < hazard_rate < 1):
            raise ValueError("hazard_rate должен быть в (0, 1)")
        if not (0 < change_threshold < 1):
            raise ValueError("change_threshold должен быть в (0, 1)")

        self.hazard_rate = hazard_rate
        self.prior = prior if prior is not None else NIGParams()
        self.change_threshold = change_threshold
        self.max_run_length = max_run_length

        # Состояние: вектор вероятностей run-lengths и соответствующие NIG-параметры
        self._R: np.ndarray = np.array([1.0])
        self._params: list = [self._fresh_prior()]
        self._t: int = 0

    # ------------------------------------------------------------------
    # Публичный API
    # ------------------------------------------------------------------

    def update(self, x: float) -> "BOCDResult":
        """
        Обработать новое наблюдение x (лог-доходность или иной сигнал).
        Возвращает BOCDResult с диагностикой текущего состояния.
        """
        R = self._R
        params = self._params

        # 1. Предиктивные вероятности p(x | r, данные за r шагов)
        #    Это плотность Student-t с параметрами, выведенными из NIG posterior.
        pred_probs = np.array([self._student_t_density(x, p) for p in params])

        # 2. Ненормированные run-length вероятности:
        #    P(r=0)   ∝ hazard * sum_r[ P(r) * p(x|r) ]  (режим сменился)
        #    P(r=k+1) ∝ (1-hazard) * P(r=k) * p(x|r=k)   (режим продолжается)
        weighted = R * pred_probs
        new_R = np.empty(len(R) + 1)
        new_R[0] = self.hazard_rate * weighted.sum()          # сброс
        new_R[1:] = (1.0 - self.hazard_rate) * weighted       # рост

        # 3. Нормализация (всегда сумма = 1)
        total = new_R.sum()
        if total < 1e-300:
            # Крайний случай: численный underflow → мягкий сброс
            new_R = np.ones(1)
            new_params = [self._fresh_prior()]
        else:
            new_R /= total

            # 4. Обновляем NIG-posterior для каждой выжившей гипотезы
            new_params = [self._fresh_prior()]           # гипотеза r=0 (смена)
            for p in params:
                new_params.append(self._nig_update(p, x))

        # 5. Обрезание: оставляем max_run_length наиболее вероятных гипотез
        if len(new_R) > self.max_run_length:
            keep = np.argpartition(new_R, -self.max_run_length)[-self.max_run_length:]
            keep = np.sort(keep)
            new_R = new_R[keep]
            new_R /= new_R.sum()
            new_params = [new_params[i] for i in keep]

        self._R = new_R
        self._params = new_params
        self._t += 1

        # 6. Формируем результат
        return self._make_result()

    def reset(self):
        """Сбросить детектор к исходному состоянию."""
        self._R = np.array([1.0])
        self._params = [self._fresh_prior()]
        self._t = 0

    @property
    def run_length_distribution(self) -> np.ndarray:
        """Полное распределение P(r_t | x_{1:t}). Индекс = длина режима."""
        return self._R.copy()

    @property
    def steps_processed(self) -> int:
        """Количество обработанных наблюдений."""
        return self._t

    # ------------------------------------------------------------------
    # Внутренние методы
    # ------------------------------------------------------------------

    def _fresh_prior(self) -> NIGParams:
        return NIGParams(
            mu=self.prior.mu,
            kappa=self.prior.kappa,
            alpha=self.prior.alpha,
            beta=self.prior.beta,
        )

    @staticmethod
    def _nig_update(p: NIGParams, x: float) -> NIGParams:
        """
        Байесовское обновление NIG-posterior после наблюдения x.
        Замкнутые формулы (сопряжённость нормального и NIG).
        """
        kappa_n = p.kappa + 1.0
        mu_n    = (p.kappa * p.mu + x) / kappa_n
        alpha_n = p.alpha + 0.5
        beta_n  = p.beta + p.kappa * (x - p.mu) ** 2 / (2.0 * kappa_n)
        return NIGParams(mu=mu_n, kappa=kappa_n, alpha=alpha_n, beta=beta_n)

    @staticmethod
    def _student_t_density(x: float, p: NIGParams) -> float:
        """
        Предиктивная плотность p(x | NIG params) = Student-t(df, loc, scale).
        df    = 2 * alpha
        loc   = mu
        scale = sqrt(beta * (kappa+1) / (alpha * kappa))
        """
        df    = 2.0 * p.alpha
        loc   = p.mu
        scale = np.sqrt(p.beta * (p.kappa + 1.0) / (p.alpha * p.kappa))
        z     = (x - loc) / scale
        log_p = (
            _log_gamma((df + 1.0) / 2.0)
            - _log_gamma(df / 2.0)
            - 0.5 * np.log(df * np.pi)
            - np.log(scale)
            - ((df + 1.0) / 2.0) * np.log1p(z * z / df)
        )
        return float(np.exp(log_p))

    def _make_result(self) -> "BOCDResult":
        R = self._R
        run_lengths = np.arange(len(R))

        # Ожидаемая и модальная длина режима
        rl_mean = float(np.dot(run_lengths, R))
        rl_mode = int(np.argmax(R))

        # Флаг смены: run_length_mode подозрительно мал относительно t
        # rl_mode <= 1: только что сменился; rl_mode / t < threshold: накопленный сигнал
        just_changed = (rl_mode <= 1 and self._t > 1)
        ratio_changed = (self._t > 5) and (rl_mode / self._t < self.change_threshold)
        regime_changed = just_changed or ratio_changed

        # Параметры текущего наиболее вероятного режима
        best_p = self._params[rl_mode]
        current_mean = float(best_p.mu)
        # E[sigma^2 | data] = beta / (alpha - 1) для alpha > 1
        denom = best_p.alpha - 1.0 if best_p.alpha > 1.0 else best_p.alpha
        current_std = float(np.sqrt(best_p.beta / denom))

        return BOCDResult(
            regime_changed=regime_changed,
            run_length_mode=rl_mode,
            run_length_mean=rl_mean,
            current_mean=current_mean,
            current_std=current_std,
            hazard_mass=float(R[0]),
            t=self._t,
        )


# ---------------------------------------------------------------------------
# Результат одного шага
# ---------------------------------------------------------------------------

@dataclass
class BOCDResult:
    """
    Результат обработки одного наблюдения.

    regime_changed   — True если детектор считает, что режим сменился
    run_length_mode  — наиболее вероятная длина текущего режима (в шагах)
    run_length_mean  — ожидаемая длина текущего режима
    current_mean     — апостериорная оценка среднего в текущем режиме
    current_std      — апостериорная оценка std в текущем режиме
    hazard_mass      — P(r=0): доля вероятности на "только что сменился"
    t                — общее число обработанных наблюдений
    """
    regime_changed:   bool
    run_length_mode:  int
    run_length_mean:  float
    current_mean:     float
    current_std:      float
    hazard_mass:      float
    t:                int

    def __repr__(self) -> str:
        flag = "CHANGE" if self.regime_changed else "stable"
        return (
            f"BOCDResult({flag} | t={self.t} "
            f"rl_mode={self.run_length_mode} "
            f"mean={self.current_mean:.5f} std={self.current_std:.5f})"
        )


# ---------------------------------------------------------------------------
# Обёртка для работы с ценовыми рядами (лог-доходности вычисляются внутри)
# ---------------------------------------------------------------------------

class MarketRegimeDetector:
    """
    Детектор режимов рынка для прямой подачи цен.
    Автоматически переводит цены в лог-доходности перед передачей в BOCD.

    Параметры
    ----------
    timeframe : 'intraday' | 'daily'
        Пресет параметров под тип данных.

    hazard_rate : float, optional
        Переопределить частоту смен режима.

    change_threshold : float
        Порог для флага regime_changed (см. BOCD).

    Пример
    ------
    detector = MarketRegimeDetector(timeframe='intraday')
    for bar in bars:
        result = detector.update(bar.close)
        if result and result.regime_changed:
            print("Режим рынка сменился!")
    """

    _PRESETS = {
        "intraday": dict(
            hazard_rate=1 / 200,
            prior=NIGParams(mu=0.0, kappa=1.0, alpha=2.0, beta=5e-7),  # ~std 0.07% per min
        ),
        "daily": dict(
            hazard_rate=1 / 50,
            prior=NIGParams(mu=0.0, kappa=1.0, alpha=2.0, beta=5e-5),  # ~std 1% per day
        ),
    }

    def __init__(
        self,
        timeframe: str = "intraday",
        hazard_rate: Optional[float] = None,
        change_threshold: float = 0.15,
    ):
        preset = self._PRESETS.get(timeframe, self._PRESETS["intraday"])
        hr = hazard_rate if hazard_rate is not None else preset["hazard_rate"]
        self._bocd = BOCD(
            hazard_rate=hr,
            prior=preset["prior"],
            change_threshold=change_threshold,
        )
        self._last_price: Optional[float] = None

    def update(self, price: float) -> Optional[BOCDResult]:
        """
        Подать цену закрытия (или mid/bid/ask).
        Возвращает None для первого наблюдения (нет предыдущей цены → нет доходности).
        """
        if self._last_price is None or self._last_price <= 0 or price <= 0:
            self._last_price = price
            return None
        log_return = np.log(price / self._last_price)
        self._last_price = price
        return self._bocd.update(log_return)

    def reset(self):
        self._bocd.reset()
        self._last_price = None

    @property
    def run_length_distribution(self) -> np.ndarray:
        return self._bocd.run_length_distribution


# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    rng = np.random.default_rng(42)

    # Два режима: низкая волатильность (300 шагов) → высокая (200 шагов)
    # prior beta=5e-7 соответствует очень маленькой дисперсии, поэтому
    # используем более ощутимое разделение для smoke-теста
    regime1 = rng.normal(0.0001, 0.005, 300)
    regime2 = rng.normal(-0.0002, 0.020, 200)
    returns = np.concatenate([regime1, regime2])

    detector = BOCD(
        hazard_rate=1 / 100,
        prior=NIGParams(mu=0.0, kappa=1.0, alpha=2.0, beta=1e-4),
        change_threshold=0.15,
    )

    print(f"{'t':>5}  {'rl_mode':>8}  {'rl_mean':>8}  {'changed':>8}  {'std':>8}")
    print("-" * 50)
    detected_at = None
    for i, r in enumerate(returns):
        res = detector.update(r)
        if i % 50 == 0 or (295 <= i <= 310):
            marker = " <<< CHANGE" if res.regime_changed and detected_at is None else ""
            if res.regime_changed and detected_at is None:
                detected_at = i
            print(
                f"{i:>5}  {res.run_length_mode:>8}  {res.run_length_mean:>8.1f}"
                f"  {str(res.regime_changed):>8}  {res.current_std:>8.5f}{marker}"
            )

    print()
    if detected_at is not None:
        print(f"Истинная смена: t=300 | Обнаружена: t={detected_at} | Задержка: {detected_at - 300} шагов")
    else:
        print("Смена не обнаружена при заданном threshold")
