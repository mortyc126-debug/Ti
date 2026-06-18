import numpy as np


def particle_filter(
    observations: list | np.ndarray,
    n_particles: int = 1000,
    process_noise: float = 0.01,
    observation_noise: float = 0.02,
    state_bounds: tuple[float, float] | None = None,
) -> dict:
    """
    Нелинейный фильтр частиц (Particle Filter / Sequential Monte Carlo)
    для оценки скрытого состояния рынка по наблюдаемым ценам.

    В отличие от линейного фильтра Калмана, не предполагает гауссовости
    шума и линейности переходов — работает с любыми распределениями
    и нелинейной динамикой. Приближает апостериорное распределение
    p(state_t | observations_{1:t}) роем частиц с весами.

    Алгоритм SIR (Sequential Importance Resampling):
        1. Predict  — сдвинуть частицы по модели перехода + шум
        2. Update   — взвесить частицы по правдоподобию наблюдения
        3. Resample — отобрать частицы пропорционально весам (устраняет вырождение)

    Модель состояния:
        state_t = state_{t-1} + process_noise * ε,   ε ~ N(0,1)
        obs_t   ~ N(state_t, observation_noise²)

    Интерпретация:
        'state_estimate'   — текущая оценка скрытой переменной (напр. «истинная цена»)
        'uncertainty'      — стандартное отклонение роя (неопределённость оценки)
        'effective_n'      — эффективное число частиц; если падает < n/2 — рой вырождается
        'regime'           — режим рынка по динамике неопределённости

    Args:
        observations:      Временной ряд наблюдений (close prices или доходности).
        n_particles:       Число частиц. Больше — точнее, медленнее. Рекомендуется 500–2000.
        process_noise:     СКО шума перехода (волатильность скрытого состояния).
        observation_noise: СКО шума наблюдения (насколько цена отклоняется от состояния).
        state_bounds:      Опциональные границы (min, max) для обрезки частиц.

    Returns:
        dict с ключами:
            'state_estimates'     — список оценок скрытого состояния по времени
            'uncertainties'       — список СКО роя по времени
            'effective_n_history' — эффективное число частиц по времени
            'final_state'         — итоговая оценка на последнем шаге
            'final_uncertainty'   — итоговая неопределённость
            'final_particles'     — финальный рой частиц (для диагностики)
            'regime'              — 'certain', 'uncertain', 'unstable'
            'trend_estimate'      — направление скрытого тренда (slope за последние 10 шагов)
            'anomaly_score'       — насколько последнее наблюдение отклонилось от состояния
    """
    obs = np.array(observations, dtype=float)
    n = len(obs)

    if n < 5:
        raise ValueError("Слишком короткий ряд. Минимум 5 точек.")

    # Инициализация частиц вокруг первого наблюдения
    rng = np.random.default_rng()
    particles = rng.normal(loc=obs[0], scale=observation_noise * 5, size=n_particles)
    weights   = np.ones(n_particles) / n_particles

    state_estimates     = []
    uncertainties       = []
    effective_n_history = []

    def gaussian_likelihood(x: np.ndarray, mean: float, std: float) -> np.ndarray:
        return np.exp(-0.5 * ((x - mean) / std) ** 2) / (std * np.sqrt(2 * np.pi))

    def systematic_resample(weights: np.ndarray, n: int) -> np.ndarray:
        """Систематический ресэмплинг — равномерно покрывает CDF весов."""
        positions = (np.arange(n) + np.random.uniform()) / n
        cumsum = np.cumsum(weights)
        indices = np.zeros(n, dtype=int)
        i, j = 0, 0
        while i < n:
            if positions[i] < cumsum[j]:
                indices[i] = j
                i += 1
            else:
                j = min(j + 1, n - 1)
        return indices

    for t in range(n):
        # --- Predict: распространить частицы по модели перехода ---
        noise = rng.normal(0, process_noise, n_particles)
        particles = particles + noise

        if state_bounds is not None:
            particles = np.clip(particles, state_bounds[0], state_bounds[1])

        # --- Update: взвесить по правдоподобию наблюдения ---
        likelihoods = gaussian_likelihood(particles, obs[t], observation_noise)
        weights     = weights * likelihoods

        weight_sum = weights.sum()
        if weight_sum < 1e-300:
            # Вырождение: сбросить веса равномерно
            weights = np.ones(n_particles) / n_particles
        else:
            weights /= weight_sum

        # --- Эффективное число частиц ---
        eff_n = 1.0 / np.sum(weights ** 2)
        effective_n_history.append(round(float(eff_n), 2))

        # --- Оценка состояния ---
        state_est = float(np.average(particles, weights=weights))
        state_std = float(np.sqrt(np.average((particles - state_est) ** 2, weights=weights)))

        state_estimates.append(round(state_est, 6))
        uncertainties.append(round(state_std, 6))

        # --- Resample если эффективный рой слишком мал ---
        if eff_n < n_particles / 2:
            indices  = systematic_resample(weights, n_particles)
            particles = particles[indices]
            weights   = np.ones(n_particles) / n_particles

    # --- Финальные метрики ---
    final_state       = state_estimates[-1]
    final_uncertainty = uncertainties[-1]

    # Тренд по последним 10 шагам
    window = min(10, len(state_estimates))
    recent = np.array(state_estimates[-window:])
    x_idx  = np.arange(window, dtype=float)
    slope, _ = np.polyfit(x_idx, recent, 1) if window > 1 else (0.0, 0.0)
    trend_estimate = round(float(slope), 6)

    # Аномальность последнего наблюдения
    anomaly_score = round(
        abs(obs[-1] - final_state) / (final_uncertainty + 1e-12), 4
    )

    # Режим по средней неопределённости в конце ряда
    tail = uncertainties[max(0, len(uncertainties) - 20):]
    mean_tail_uncertainty = float(np.mean(tail))
    obs_std = float(obs.std() + 1e-12)
    rel_uncertainty = mean_tail_uncertainty / obs_std

    if rel_uncertainty < 0.1:
        regime = "certain"
    elif rel_uncertainty < 0.4:
        regime = "uncertain"
    else:
        regime = "unstable"

    return {
        "state_estimates":     state_estimates,
        "uncertainties":       uncertainties,
        "effective_n_history": effective_n_history,
        "final_state":         final_state,
        "final_uncertainty":   final_uncertainty,
        "final_particles":     particles.tolist(),
        "regime":              regime,
        "trend_estimate":      trend_estimate,
        "anomaly_score":       anomaly_score,
    }


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    rng = np.random.default_rng(42)
    n = 200

    # Тренд со скрытым состоянием и наблюдательным шумом
    true_state = np.cumsum(rng.normal(0.002, 0.01, n)) + 100
    noisy_obs  = true_state + rng.normal(0, 0.05, n)

    res = particle_filter(noisy_obs, n_particles=1000,
                          process_noise=0.01, observation_noise=0.05)

    print("Результат фильтра частиц:")
    for k, v in res.items():
        if k not in ("state_estimates", "uncertainties",
                     "effective_n_history", "final_particles"):
            print(f"  {k}: {v}")

    # Точность: MAE между оценкой и истинным состоянием
    estimates = np.array(res["state_estimates"])
    mae = float(np.mean(np.abs(estimates - true_state)))
    print(f"  mae_vs_true_state: {round(mae, 6)}")
