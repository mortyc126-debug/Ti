"""
rule_miner.py — поиск конъюнктивных правил ("если A и B, то цена идёт в
свою сторону") в истории сделок через простое дерево решений (CART,
без внешних зависимостей — тот же numpy-free стиль, что lasso_calibration.py).

Зачем не лассо: elastic net/group lasso (lasso_calibration.py) — линейная
модель, она находит ВЕС каждого метода/кластера, но не может выразить
конъюнкцию вида "Объём>0.3 И Тренд>0.2" — для линейной комбинации это
неотличимо от просто "Объём+Тренд большие по отдельности". Дерево решений
явно разбивает выборку по порогам и может найти такие сочетания.

Это разведочный инструмент: правила, которые он находит — ГИПОТЕЗЫ
("в этом срезе истории такая конъюнкция работала"), не готовые к
автоприменению. Числовые пороги в дереве берутся из самих данных
(точки сплита), не угадываются руками. Дерево сегментируется по regime
(regime.py REGIMES) — то же основание, что и regime_method_performance
в history.py: правило, работающее в trending_up, не обязано работать
в ranging.

Использование:
    python rule_miner.py SBER --days 180
    python rule_miner.py --all --days 180 --max-depth 3
"""
import argparse
import json
import os
from datetime import datetime, timezone

from cluster_models import STRATEGY_CLUSTERS, MODEL_NAMES
from dashboard import _strategy_settings_by_ticker
from history import HistoryStore
from trade_system.strategies.oi_composite_strategy import STRATEGY_VERSION
from lasso_calibration import _build_features, _signed_outcome, _EXCLUDE_FROM_FEATURES

RULES_FILE = "data/mined_rules.json"

MIN_TRADES_PER_REGIME = 15
_DEFAULT_MAX_DEPTH = 3
_MIN_LEAF = 5


# ── Дерево решений (CART, регрессия на signed_outcome) ───────────────────────

class _Node:
    def __init__(self):
        self.is_leaf = True
        self.value = 0.0  # среднее y в листе
        self.n = 0
        self.feature: str | None = None
        self.threshold: float = 0.0
        self.left: "_Node | None" = None
        self.right: "_Node | None" = None


def _variance_reduction(y: list[float], y_left: list[float], y_right: list[float]) -> float:
    def _var(v: list[float]) -> float:
        if not v:
            return 0.0
        m = sum(v) / len(v)
        return sum((x - m) ** 2 for x in v) / len(v)

    n = len(y)
    return _var(y) - (len(y_left) / n) * _var(y_left) - (len(y_right) / n) * _var(y_right)


def _best_split(
    X: list[list[float]], y: list[float], feature_names: list[str],
) -> tuple[int, float, float] | None:
    """Перебор всех фичей и всех уникальных значений как порога — находит
    разбиение с максимальным снижением дисперсии y. O(n*p*n) — приемлемо
    для сотен сделок и десятков фичей (разведочный скрипт, не онлайн-путь)."""
    n = len(y)
    best = None  # (gain, j, thresh)
    for j in range(len(feature_names)):
        col = [X[i][j] for i in range(n)]
        candidates = sorted(set(col))
        if len(candidates) < 2:
            continue
        for k in range(len(candidates) - 1):
            thresh = (candidates[k] + candidates[k + 1]) / 2.0
            y_left = [y[i] for i in range(n) if col[i] <= thresh]
            y_right = [y[i] for i in range(n) if col[i] > thresh]
            if len(y_left) < _MIN_LEAF or len(y_right) < _MIN_LEAF:
                continue
            gain = _variance_reduction(y, y_left, y_right)
            if best is None or gain > best[0]:
                best = (gain, j, thresh)
    if best is None or best[0] <= 0:
        return None
    return best[1], best[2], best[0]


def _build_tree(
    X: list[list[float]], y: list[float], feature_names: list[str], depth: int, max_depth: int,
) -> _Node:
    node = _Node()
    node.n = len(y)
    node.value = sum(y) / len(y) if y else 0.0
    if depth >= max_depth or len(y) < 2 * _MIN_LEAF:
        return node

    split = _best_split(X, y, feature_names)
    if split is None:
        return node

    j, thresh, _gain = split
    idx_left = [i for i in range(len(y)) if X[i][j] <= thresh]
    idx_right = [i for i in range(len(y)) if X[i][j] > thresh]

    node.is_leaf = False
    node.feature = feature_names[j]
    node.threshold = thresh
    node.left = _build_tree(
        [X[i] for i in idx_left], [y[i] for i in idx_left], feature_names, depth + 1, max_depth,
    )
    node.right = _build_tree(
        [X[i] for i in idx_right], [y[i] for i in idx_right], feature_names, depth + 1, max_depth,
    )
    return node


def _extract_rules(node: _Node, path: list[str], out: list[dict]) -> None:
    """Спускается по дереву, на каждом листе формирует правило — конъюнкцию
    условий по пути от корня."""
    if node.is_leaf:
        if path:
            out.append({
                "conditions": list(path),
                "avg_outcome": round(node.value, 5),
                "n_trades": node.n,
            })
        return
    _extract_rules(node.left, path + [f"{node.feature} <= {node.threshold:.4f}"], out)
    _extract_rules(node.right, path + [f"{node.feature} > {node.threshold:.4f}"], out)


# ── Майнинг по тикеру, сегментировано по regime ──────────────────────────────

def _mine_one(ticker: str, days: int, max_depth: int) -> dict | None:
    by_ticker = _strategy_settings_by_ticker()
    if ticker not in by_ticker:
        print(f"{ticker}: нет в settings.ini/oi_tickers.json — пропуск")
        return None

    store = HistoryStore()
    trades = store.get_trades(ticker, window_days=days)
    if not trades:
        print(f"{ticker}: нет сделок в истории — пропуск")
        return None

    # См. lasso_calibration.py — то же снижение веса устаревших (до текущей
    # ревизии стратегии) сделок, чтобы майнинг правил не путал старую и новую
    # механику входа/выхода.
    trades = HistoryStore.reweight_trades_by_version(trades, STRATEGY_VERSION)

    all_methods: set[str] = set()
    for t in trades:
        all_methods.update(t.get("method_scores", {}).keys())
    methods = sorted(all_methods - _EXCLUDE_FROM_FEATURES)
    if not methods:
        print(f"{ticker}: нет методов после исключения метамоделей — пропуск")
        return None

    by_regime: dict[str, list[dict]] = {}
    for t in trades:
        if _signed_outcome(t) is None:
            continue
        regime = t.get("regime") or "unknown"
        by_regime.setdefault(regime, []).append(t)

    result: dict = {
        "computed_at": datetime.now(timezone.utc).date().isoformat(),
        "window_days": days,
        "max_depth": max_depth,
        "regimes": {},
    }
    any_rules = False
    for regime, regime_trades in sorted(by_regime.items()):
        if len(regime_trades) < MIN_TRADES_PER_REGIME:
            print(f"{ticker}/{regime}: {len(regime_trades)} сделок < {MIN_TRADES_PER_REGIME} — пропуск")
            continue
        feature_names, X = _build_features(regime_trades, methods)
        y = [_signed_outcome(t) for t in regime_trades]

        tree = _build_tree(X, y, feature_names, depth=0, max_depth=max_depth)
        rules: list[dict] = []
        _extract_rules(tree, [], rules)
        rules.sort(key=lambda r: abs(r["avg_outcome"]), reverse=True)

        result["regimes"][regime] = {
            "n_trades": len(regime_trades),
            "root_avg_outcome": round(tree.value, 5),
            "rules": rules,
        }
        any_rules = any_rules or bool(rules)
        print(f"{ticker}/{regime}: {len(regime_trades)} сделок, {len(rules)} правил-листьев "
              f"(средний исход без правил: {tree.value:.4f})")
        for r in rules[:5]:
            cond = " И ".join(r["conditions"])
            print(f"    {cond}  →  avg={r['avg_outcome']:+.4f}  (n={r['n_trades']})")

    if not any_rules:
        print(f"{ticker}: ни одного режима с достаточным числом сделок — пропуск")
        return None
    return result


def _load_existing() -> dict:
    if os.path.exists(RULES_FILE):
        try:
            with open(RULES_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save(data: dict) -> None:
    os.makedirs(os.path.dirname(RULES_FILE), exist_ok=True)
    with open(RULES_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("ticker", nargs="?",
                        help="один тикер, список через запятую, или --all")
    parser.add_argument("--all", action="store_true",
                        help="прогнать по всем тикерам из settings.ini/oi_tickers.json")
    parser.add_argument("--days", type=int, default=180, help="окно истории сделок")
    parser.add_argument("--max-depth", type=int, default=_DEFAULT_MAX_DEPTH,
                        help="макс. глубина дерева (= макс. длина конъюнкции правила)")
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
    for i, ticker in enumerate(tickers, 1):
        if len(tickers) > 1:
            print(f"[{i}/{len(tickers)}]", end=" ")
        try:
            result = _mine_one(ticker, args.days, args.max_depth)
        except Exception as e:
            print(f"{ticker}: непредвиденная ошибка ({e}) — пропуск")
            continue
        if result:
            existing[ticker] = result

    _save(existing)
    print(f"\nСохранено → {RULES_FILE} ({len(existing)} тикеров всего)")


if __name__ == "__main__":
    main()
