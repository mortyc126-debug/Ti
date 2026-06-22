"""
calibrate_narrative.py — калибрует пороги тегов narrative.py (bullish_thresh,
accum_thresh, climax_spread) по перцентилям РЕАЛЬНОГО распределения
кластерных скоров, ОТДЕЛЬНО для каждого regime (то, что бычье в trending_up,
может быть медианой в ranging — общий порог на все режимы смазывает это).

Без этого скрипта classify_directional/classify_volume используют
захардкоженные дефолты (0.2 / 1.0) — рабочие на старте, но угаданные.
Здесь пороги выводятся из data/history.json: для каждого (cluster, regime)
берём дневные скоры всех методов кластера, считаем кластерное среднее
(direction) и разброс (volume) за каждый день, и берём перцентили этого
распределения как порог "явно бычий"/"явно climax".

Источник данных — data/history.json (HistoryStore), который наполняется
либо живой торговлей, либо dashboard.save_backtest_history(tickers, days)
(см. run_pipeline.py — он делает это автоматически перед калибровкой).

    python calibrate_narrative.py SBER
    python calibrate_narrative.py --all
"""
import argparse
import json
import os

from cluster_models import STRATEGY_CLUSTERS
from dashboard import _strategy_settings_by_ticker
from history import HistoryStore
from narrative import NARRATIVE_THRESHOLDS_FILE

# Перцентили, определяющие "явно выраженный" сигнал — выше них направление
# считается не шумом, а реальным согласием кластера. 65/35 — не середина
# (50/50 ловила бы шум), но и не крайность (90/10 почти никогда не сработает).
_DIRECTIONAL_PCT = 0.65
_VOLUME_PCT = 0.65
# Перцентиль РАЗБРОСА (не среднего) для CLIMAX — верхний хвост распределения
# спреда внутри группы "Объём" за день.
_CLIMAX_SPREAD_PCT = 0.85

MIN_DAYS_PER_REGIME = 20


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    idx = min(len(s) - 1, max(0, int(len(s) * pct)))
    return s[idx]


def _calibrate_one(ticker: str, days: int) -> dict | None:
    store = HistoryStore()
    by_regime = store.daily_method_scores_by_regime(ticker, window_days=days)
    if not by_regime:
        print(f"{ticker}: нет дневной истории scores — пропуск")
        return None

    result: dict[str, dict[str, dict[str, float]]] = {}
    for cl in STRATEGY_CLUSTERS:
        label = cl["label"]
        ids = cl["ids"]
        for regime, day_scores_list in by_regime.items():
            if len(day_scores_list) < MIN_DAYS_PER_REGIME:
                continue
            avgs: list[float] = []
            spreads: list[float] = []
            for day_scores in day_scores_list:
                vals = [day_scores[m] for m in ids if m in day_scores]
                if not vals:
                    continue
                avgs.append(sum(vals) / len(vals))
                spreads.append(max(vals) - min(vals))
            if not avgs:
                continue
            bullish = _percentile([abs(a) for a in avgs], _DIRECTIONAL_PCT)
            accum = _percentile([abs(a) for a in avgs], _VOLUME_PCT)
            climax_spread = _percentile(spreads, _CLIMAX_SPREAD_PCT)
            result.setdefault(label, {})[regime] = {
                "bullish": round(bullish, 4),
                "accum": round(accum, 4),
                "climax_spread": round(climax_spread, 4),
                "n_days": len(avgs),
            }

    if not result:
        print(f"{ticker}: ни одного (кластер, режим) с >= {MIN_DAYS_PER_REGIME} дней — пропуск")
        return None

    n_pairs = sum(len(v) for v in result.values())
    print(f"{ticker}: калибровано {n_pairs} пар (кластер, режим)")
    return result


def _load_existing() -> dict:
    if os.path.exists(NARRATIVE_THRESHOLDS_FILE):
        try:
            with open(NARRATIVE_THRESHOLDS_FILE, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save(data: dict) -> None:
    os.makedirs(os.path.dirname(NARRATIVE_THRESHOLDS_FILE) or ".", exist_ok=True)
    with open(NARRATIVE_THRESHOLDS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _merge(existing: dict, ticker_result: dict) -> dict:
    """Калибровка ОБЩАЯ по тикеру (не per-ticker файл, в отличие от lasso) —
    narrative.py читает один файл без привязки к тикеру/figi, т.к. NarrativeState
    у каждого инстанса OICompositeStrategy свой, но пороги общие по кластеру/
    режиму. При нескольких тикерах — последний прогон побеждает по
    пересекающимся (cluster, regime) парам (не усредняем, чтобы не размывать
    калибровку конкретного инструмента шумом другого)."""
    for label, regimes in ticker_result.items():
        existing.setdefault(label, {}).update(regimes)
    return existing


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("ticker", nargs="?",
                        help="один тикер, список через запятую, или --all")
    parser.add_argument("--all", action="store_true",
                        help="прогнать по всем тикерам из settings.ini/oi_tickers.json")
    parser.add_argument("--days", type=int, default=180, help="окно дневной истории")
    args = parser.parse_args()

    if args.all:
        tickers = list(_strategy_settings_by_ticker().keys())
    elif args.ticker and "," in args.ticker:
        tickers = [t.strip() for t in args.ticker.split(",") if t.strip()]
    elif args.ticker:
        tickers = [args.ticker]
    else:
        parser.error("укажи тикер, список через запятую, или --all")
        return

    existing = _load_existing()
    for ticker in tickers:
        result = _calibrate_one(ticker, args.days)
        if result:
            existing = _merge(existing, result)

    _save(existing)
    print(f"\nСохранено → {NARRATIVE_THRESHOLDS_FILE}")


if __name__ == "__main__":
    main()
