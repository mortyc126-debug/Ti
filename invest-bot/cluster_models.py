"""
cluster_models.py — три конкурирующих модели (M1/M2/M3) поверх семантических
кластеров методов. Архитектура портирована из indlab_v10.html (main-ветка),
адаптирована для бота с новыми научными методами.

Кластеры объединяют методы по физическому смыслу сигнала, а не по источнику
данных. Внутри каждого кластера методы конкурируют по точности (effWR) в
текущем режиме рынка — лучший за период получает больший вес.

Модели:
  M1 (Весовая агрегация):
      Вес метода = effWR × (1 − |corr с лидером кластера|).
      Снижает влияние дублирующих методов, сохраняет разнообразные сигналы.
      Итог кластера = взвешенная сумма. Итог M1 = средн. по кластерам.

  M2 (Представители кластеров):
      Только лидер (лучший effWR) от каждого кластера.
      Чище M1, меньше шума, проигрывает в полноте.

  M3 (Кластерное подтверждение):
      Лидер даёт направление, agreement = доля методов согласных с лидером.
      score_кластера = leader_score × agreement.
      Входит только когда кластер единодушен — сильный фильтр шума.

effWR(method, regime) берётся из HistoryStore.regime_method_performance —
реальная точность метода в текущем режиме за 90 дней.
Fallback: method_performance (общая точность), затем 0.5 (нейтраль).

RMT-очистка корреляций: когда history содержит ≥30 дней скоров,
матрица корреляций очищается через Marchenko-Pastur фильтр (random_matrix_theory.py)
— убирает шум из случайных совпадений, как в M1-формуле indlab.
"""
import logging
import math
from typing import Optional

__all__ = ("ClusterModels", "STRATEGY_CLUSTERS", "MODEL_NAMES")

logger = logging.getLogger(__name__)

# ── 11 семантических кластеров ────────────────────────────────────────────────
# Методы распределены по физическому смыслу:
#   - Тренд: направленное движение цены
#   - Импульс: скорость/сила изменения
#   - Объём: потоки ликвидности
#   - Волатильность: интенсивность событий
#   - Адаптивные МА: следящие за ценой системы с памятью
#   - Фрактальность: сложность/предсказуемость структуры
#   - Энтропия: информационный беспорядок/поток
#   - Циклы: периодические компоненты
#   - Режим рынка: мета-сигнал о характере движения
#   - Микроструктура: стакан/потоки ордеров/отмены
#   - Позиционирование: открытый интерес, межинструментальный поток
STRATEGY_CLUSTERS = [
    {
        "label": "Тренд",
        "ids": ["PRICE_TREND", "VWAP_SIGNAL", "SSA_SIGNAL", "TREND_QUALITY"],
        # PRICE_TREND использует Kalman velocity, SSA — разложение на тренд
    },
    {
        "label": "Импульс",
        "ids": ["BS_PRESSURE", "CANDLE_PATTERN", "RMI", "FISHER_RSI"],
    },
    {
        "label": "Объём",
        "ids": ["VOL_MOMENTUM", "KLINGER", "VZO", "TWIGGS"],
    },
    {
        "label": "Волатильность",
        "ids": ["YZ_VOL_SIGNAL", "HAWKES_SIGNAL"],
        # HAWKES: branching ratio = кластеризация событий = режим высокой воло
    },
    {
        "label": "Адаптивные МА",
        "ids": ["ADAPTIVE_MA", "ZLEMA_SIGNAL", "T3_SIGNAL"],
    },
    {
        "label": "Фрактальность",
        "ids": ["FRACTAL", "VR_SIGNAL"],
        # VR_SIGNAL: variance ratio = отклонение от случайного блуждания
    },
    {
        "label": "Энтропия",
        "ids": ["ENTROPY", "MULTI_TICKER"],
        # MULTI_TICKER: transfer entropy / wavelet coherence = направленный
        # информационный поток между инструментами
    },
    {
        "label": "Циклы",
        "ids": ["CYBER_CYCLE", "DECYCLER", "EBSW", "SINEWAVE_SIGNAL"],
        # WAVELET_SIGNAL убран из методов: работает только как множитель уверенности
    },
    {
        "label": "Режим рынка",
        "ids": ["MMI_SIGNAL", "ZSCORE", "CHANGE_POINT"],
        # CHANGE_POINT: CUSUM/PELT/BOCD — смена режима
        # VOLATILITY_REG убран: используется как vhf_mult множитель, не голос
    },
    {
        "label": "Микроструктура",
        "ids": [
            "OB_IMBALANCE", "CANCEL_SIGNAL",
            "BS_PRESSURE_TS", "AGGRESSOR_FLOW", "LARGE_IMPACT",
            "VWAP_SIGNAL_TS", "VOL_MOMENTUM_TS",
        ],
    },
    {
        "label": "Позиционирование",
        "ids": ["OI_SQUEEZE", "INST_OI", "RETAIL_CONTRA"],
    },
]

MODEL_NAMES = ["M1_CLUSTER", "M2_CLUSTER", "M3_CLUSTER"]

# Минимум наблюдений на метод для того, чтобы его effWR учитывался
_MIN_OBS = 10


def _pearson(a: list[float], b: list[float]) -> float:
    """Корреляция Пирсона двух score-рядов. Только ненулевые пары."""
    pairs = [(x, y) for x, y in zip(a, b) if x != 0 and y != 0]
    n = len(pairs)
    if n < 10:
        return 0.0
    ma = sum(p[0] for p in pairs) / n
    mb = sum(p[1] for p in pairs) / n
    num = da = db = 0.0
    for x, y in pairs:
        A, B = x - ma, y - mb
        num += A * B
        da += A * A
        db += B * B
    return num / math.sqrt(da * db) if da > 0 and db > 0 else 0.0


def _rmt_clean_corr(series: dict[str, list[float]]) -> dict[tuple, float]:
    """
    RMT-очищенная матрица корреляций (Marchenko-Pastur фильтр).
    Убирает шумовые собственные значения — реальная корреляция остаётся.
    Fallback на raw Pearson если numpy/RMT недоступны.
    """
    ids = list(series.keys())
    try:
        import numpy as np
        from random_matrix_theory import rmt_corr_weight
        n_methods = len(ids)
        n_obs = max(len(v) for v in series.values())
        if n_methods < 2 or n_obs < n_methods:
            raise ValueError("недостаточно данных для RMT")
        # Выровнять ряды по длине
        min_len = min(len(series[i]) for i in ids)
        mat = np.array([series[i][-min_len:] for i in ids], dtype=float)
        cleaned = rmt_corr_weight(mat.T)  # shape (n_obs, n_methods)
        result = {}
        for i, id_i in enumerate(ids):
            for j, id_j in enumerate(ids):
                result[(id_i, id_j)] = float(cleaned[i, j])
        return result
    except Exception:
        # Fallback: raw Pearson
        result = {}
        for id_i in ids:
            for id_j in ids:
                result[(id_i, id_j)] = _pearson(series[id_i], series[id_j])
        return result


class ClusterModels:
    """
    Вычисляет скоры M1/M2/M3 для текущего бара.
    Инициализируется из HistoryStore — загружает серии исторических скоров и
    точность методов в каждом режиме. Пересчитывается при смене режима или
    раз в N дней (см. needs_refresh).

    Использование:
        models = ClusterModels(history, ticker)
        models.refresh(current_regime)
        m1, m2, m3 = models.compute(current_scores: dict[str, float])
    """

    def __init__(self, history, ticker: str):
        self._history = history
        self._ticker = ticker
        self._regime: str = ""
        # {method: [daily scores ordered by date]} — пул по всем режимам,
        # используется для M1/M2/M3 (там сглаживание по режимам не нужно,
        # effWR уже режимный).
        self._series: dict[str, list[float]] = {}
        # {method: effWR float}
        self._eff_wr: dict[str, float] = {}
        # RMT-cleaned correlation matrix по всем режимам вместе (fallback,
        # когда конкретного режима в _corr_by_regime недостаточно данных)
        self._corr: dict[tuple, float] = {}
        # {regime: {(id_i, id_j): corr}} — RMT-корреляция ОТДЕЛЬНО по
        # каждому режиму (Layer 4), см. redundancy_dampen.
        self._corr_by_regime: dict[str, dict[tuple, float]] = {}
        self._ready = False

    def refresh(self, regime: str) -> None:
        """
        Загружает/обновляет серии скоров и effWR из истории.
        Вызывать при смене режима или в начале торгового дня.
        """
        self._regime = regime
        ticker = self._ticker

        # Серии дневных скоров по каждому методу (последние 90 дней)
        all_ids = [mid for cl in STRATEGY_CLUSTERS for mid in cl["ids"]]
        self._series = {
            mid: self._history.daily_scores(ticker, mid, window_days=90)
            for mid in all_ids
        }
        # Отфильтровать методы с недостаточной историей
        self._series = {k: v for k, v in self._series.items() if len(v) >= _MIN_OBS}

        # effWR: режимная точность → общая точность → 0.5
        regime_perf = self._history.regime_method_performance(ticker, window_days=90)
        method_perf = self._history.method_performance(ticker, window_days=90)

        self._eff_wr = {}
        for mid in all_ids:
            regime_acc = regime_perf.get(regime, {}).get(mid)
            general_acc = method_perf.get(mid, {}).get("avg_quality")
            self._eff_wr[mid] = regime_acc if regime_acc is not None else (
                general_acc if general_acc is not None else 0.5
            )

        # RMT-очищенная матрица корреляций — общая (fallback)
        if len(self._series) >= 2:
            self._corr = _rmt_clean_corr(self._series)

        # Layer 4: те же ряды, но разбитые по day["regime"] — корреляция
        # между методами не одинакова во всех режимах (напр. микроструктурные
        # методы синхронны в stress, но независимы в ranging), общая матрица
        # это усредняет и теряет. Считаем отдельно на каждый режим с
        # достаточным числом наблюдений, fallback на self._corr иначе.
        per_regime_series: dict[str, dict[str, list[float]]] = {}
        for mid in all_ids:
            by_regime = self._history.daily_scores_by_regime(ticker, mid, window_days=90)
            for r, vals in by_regime.items():
                per_regime_series.setdefault(r, {})[mid] = vals
        self._corr_by_regime = {}
        for r, series in per_regime_series.items():
            series = {k: v for k, v in series.items() if len(v) >= _MIN_OBS}
            if len(series) >= 2:
                self._corr_by_regime[r] = _rmt_clean_corr(series)

        self._ready = bool(self._series)
        logger.info(
            f"ClusterModels {ticker} refresh: режим={regime}, "
            f"методов с историей={len(self._series)}/{len(all_ids)}, "
            f"режимов с RMT-корреляцией={len(self._corr_by_regime)}"
        )

    def needs_refresh(self, regime: str) -> bool:
        return not self._ready or regime != self._regime

    def compute(self, current_scores: dict[str, float]) -> tuple[float, float, float]:
        """
        Вычисляет (m1_score, m2_score, m3_score) для текущего бара.
        current_scores — словарь {method_name: score} из __compute_composite.
        Если истории недостаточно — возвращает (0, 0, 0).
        """
        if not self._ready:
            return 0.0, 0.0, 0.0

        m1_parts: list[tuple[float, float]] = []  # (score, confidence)
        m2_parts: list[tuple[float, float]] = []
        m3_parts: list[tuple[float, float]] = []

        for cluster in STRATEGY_CLUSTERS:
            # Только методы с историей И с ненулевым текущим скором
            ids = [
                mid for mid in cluster["ids"]
                if mid in self._series and mid in current_scores
            ]
            if not ids:
                continue

            # Лидер = метод с наибольшим effWR в текущем режиме
            leader = max(ids, key=lambda mid: self._eff_wr.get(mid, 0.5))

            # ── M1: весовая агрегация WR × (1 − |corr с лидером|) ─────────
            weights_m1 = {}
            for mid in ids:
                wr = self._eff_wr.get(mid, 0.5)
                if mid == leader:
                    corr = 1.0
                else:
                    corr = self._corr.get((leader, mid), _pearson(
                        self._series.get(leader, []),
                        self._series.get(mid, [])
                    ))
                weights_m1[mid] = wr * (1.0 - abs(corr)) if mid != leader else wr

            tot_w = sum(weights_m1.values()) or 1.0
            m1_score = sum(
                weights_m1[mid] / tot_w * current_scores[mid]
                for mid in ids
            )
            m1_score = max(-1.0, min(1.0, m1_score))
            m1_conf = min(0.75, (tot_w / len(ids)) * 0.6)
            if m1_conf > 0:
                m1_parts.append((m1_score, m1_conf))

            # ── M2: только лидер кластера ──────────────────────────────────
            leader_wr = self._eff_wr.get(leader, 0.5)
            m2_score = current_scores.get(leader, 0.0)
            m2_conf = leader_wr * 0.85
            if m2_conf > 0:
                m2_parts.append((m2_score, m2_conf))

            # ── M3: лидер × agreement (доля методов согласных с лидером) ──
            leader_sc = current_scores.get(leader, 0.0)
            leader_dir = 1 if leader_sc > 0 else (-1 if leader_sc < 0 else 0)
            if leader_dir == 0:
                continue
            agree = sum(
                1 for mid in ids
                if (current_scores.get(mid, 0) > 0) == (leader_dir > 0)
            )
            agreement = agree / len(ids) if len(ids) > 1 else 1.0
            m3_score = leader_sc * agreement
            m3_conf = leader_wr * agreement
            if m3_conf > 0:
                m3_parts.append((m3_score, m3_conf))

        def _agg(parts: list[tuple[float, float]]) -> float:
            if not parts:
                return 0.0
            tw = sum(c for _, c in parts) or 1.0
            return sum(s * c / tw for s, c in parts)

        return _agg(m1_parts), _agg(m2_parts), _agg(m3_parts)

    def redundancy_dampen(
            self, method_names: list[str], regime_probs: Optional[dict[str, float]] = None
    ) -> dict[str, float]:
        """
        Множитель [0.3, 1.0] на вес метода — штраф за среднюю RMT-очищенную
        корреляцию с остальными методами из переданного списка. Применяется
        в __compute_composite к base_scores ПЕРЕД сложением с M1/M2/M3, чтобы
        кластер сильно скоррелированных методов не учитывался многократно.

        Layer 4: если передан regime_probs (распределение вероятностей по
        режимам, как в Layer 2 regime_mods) — корреляция берётся как смесь
        per-regime матриц self._corr_by_regime, взвешенная по p(regime), а не
        одна общая матрица self._corr. Для режима без своей матрицы (мало
        наблюдений) откат на self._corr этого же расчёта — как и в Layer 2
        откат на статику при отсутствии динамики.
        Методы без истории получают множитель 1.0.
        """
        if not self._ready:
            return {name: 1.0 for name in method_names}

        def _avg_abs_corr(corr: dict[tuple, float], mid: str) -> Optional[float]:
            others = [n for n in method_names if n != mid and (mid, n) in corr]
            if not others:
                return None
            return sum(abs(corr[(mid, n)]) for n in others) / len(others)

        result = {}
        for mid in method_names:
            if regime_probs:
                blended = 0.0
                total_p = 0.0
                for r, p in regime_probs.items():
                    if p <= 0.0:
                        continue
                    corr = self._corr_by_regime.get(r) or self._corr
                    if not corr:
                        continue
                    avg = _avg_abs_corr(corr, mid)
                    if avg is None:
                        continue
                    blended += p * avg
                    total_p += p
                if total_p <= 0.0:
                    result[mid] = 1.0
                    continue
                avg_abs_corr = blended / total_p
            else:
                if not self._corr:
                    result[mid] = 1.0
                    continue
                avg = _avg_abs_corr(self._corr, mid)
                if avg is None:
                    result[mid] = 1.0
                    continue
                avg_abs_corr = avg
            result[mid] = max(0.3, 1.0 - avg_abs_corr)
        return result
