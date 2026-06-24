"""
bar_rule_miner.py — поиск конъюнктивных паттернов в bar_scores CSV.

В отличие от rule_miner.py (работает на истории сделок), здесь вход —
сырые бары из export_bar_scores_csv / data/bar_scores/*.csv. Каждый бар
описывается скорами 47 методов + режимом + OHLCV.

Целевая переменная: fwd_ret_3/6/12/24/48 (выбор через --target).
  3  = +3 бара  (~15м на M5)
  6  = +6 баров (~30м)
  12 = +12 баров (~1ч)
  24 = +24 бара  (~2ч)
  48 = +48 баров (~4ч / полдня)

Дерево CART сегментировано по режиму — правило работающее в trending_up
не обязано работать в ranging.

Дополнительные фичи (конструируются из OHLCV):
  log_vol   — log(volume), нормализует хвосты объёма
  body_pct  — |close-open|/open, размер тела свечи
  wick_pct  — (high-low)/open, размер фитиля

apply_rules_to_csv() — применяет правила одного тикера к CSV другого
(напр. правила AFKS → фьючерс AFKSU5). Полезно когда акция ликвиднее
и история длиннее, а торговать хочется фьючерсом.

Вывод:
  - консоль: топ правил по |avg_fwd_ret|
  - data/bar_rules/{TICKER}_{days}d.json

Использование:
    python bar_rule_miner.py AFKS --days 365
    python bar_rule_miner.py AFKS AFLT SBER --days 365 --target fwd_ret_12
    python bar_rule_miner.py --all --days 365 --max-depth 4 --min-n 100
    python bar_rule_miner.py --apply AFKS --to AFKSU5 --days 365
"""
import argparse
import csv
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path

BAR_SCORES_DIR = "data/bar_scores"
BAR_RULES_DIR  = "data/bar_rules"
_DEFAULT_MAX_DEPTH = 4
_MIN_LEAF = 50          # минимум баров в листе — меньше нельзя, шум
_MIN_REGIME_BARS = 200  # минимум баров режима для сегмента
_FWD_COLS = ("fwd_ret_3", "fwd_ret_6", "fwd_ret_12", "fwd_ret_24", "fwd_ret_48")
_FWD_LABELS = {
    "fwd_ret_3":  "+3 бара (~15м)",
    "fwd_ret_6":  "+6 баров (~30м)",
    "fwd_ret_12": "+12 баров (~1ч)",
    "fwd_ret_24": "+24 бара (~2ч)",
    "fwd_ret_48": "+48 баров (~4ч)",
}

_SKIP_FEATURES = frozenset({
    "time", "open", "high", "low", "close", "volume", "regime",
    *_FWD_COLS,
    # метамодели — производные от базовых методов, двойной счёт
    "M1_CLUSTER", "M2_CLUSTER", "M3_CLUSTER",
})


# ── CART (идентичен rule_miner.py, без внешних зависимостей) ─────────────────

class _Node:
    def __init__(self):
        self.is_leaf   = True
        self.value     = 0.0
        self.n         = 0
        self.feature: str | None  = None
        self.threshold: float     = 0.0
        self.left:  "_Node | None" = None
        self.right: "_Node | None" = None


def _var(v: list[float]) -> float:
    if len(v) < 2:
        return 0.0
    m = sum(v) / len(v)
    return sum((x - m) ** 2 for x in v) / len(v)


def _best_split(X, y, feature_names):
    n = len(y)
    best = None
    for j, name in enumerate(feature_names):
        col = [X[i][j] for i in range(n)]
        uniq = sorted(set(col))
        if len(uniq) < 2:
            continue
        for k in range(len(uniq) - 1):
            thresh = (uniq[k] + uniq[k + 1]) / 2.0
            left_y  = [y[i] for i in range(n) if col[i] <= thresh]
            right_y = [y[i] for i in range(n) if col[i] >  thresh]
            if len(left_y) < _MIN_LEAF or len(right_y) < _MIN_LEAF:
                continue
            gain = _var(y) - (len(left_y)/n)*_var(left_y) - (len(right_y)/n)*_var(right_y)
            if best is None or gain > best[0]:
                best = (gain, j, thresh)
    if best is None or best[0] <= 0:
        return None
    return best[1], best[2], best[0]


def _build_tree(X, y, feature_names, depth, max_depth):
    node = _Node()
    node.n     = len(y)
    node.value = sum(y) / len(y) if y else 0.0
    if depth >= max_depth or len(y) < 2 * _MIN_LEAF:
        return node
    split = _best_split(X, y, feature_names)
    if split is None:
        return node
    j, thresh, _ = split
    il = [i for i in range(len(y)) if X[i][j] <= thresh]
    ir = [i for i in range(len(y)) if X[i][j] >  thresh]
    node.is_leaf   = False
    node.feature   = feature_names[j]
    node.threshold = thresh
    node.left  = _build_tree([X[i] for i in il], [y[i] for i in il], feature_names, depth+1, max_depth)
    node.right = _build_tree([X[i] for i in ir], [y[i] for i in ir], feature_names, depth+1, max_depth)
    return node


def _extract_rules(node, path, out):
    if node.is_leaf:
        if path:
            pos = sum(1 for _ in path if True)  # len(path) — глубина правила
            out.append({
                "conditions": list(path),
                "avg_fwd_ret": round(node.value, 6),
                "n_bars": node.n,
                "depth": len(path),
            })
        return
    _extract_rules(node.left,  path + [f"{node.feature} <= {node.threshold:.4f}"], out)
    _extract_rules(node.right, path + [f"{node.feature} > {node.threshold:.4f}"],  out)


# ── Загрузка CSV ──────────────────────────────────────────────────────────────

def _load_csv(path: str) -> list[dict]:
    with open(path, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def _find_csv(ticker: str, days: int | None) -> str | None:
    """Ищет файл в data/bar_scores/. Если days=None — берёт самый свежий для тикера."""
    d = Path(BAR_SCORES_DIR)
    if not d.exists():
        return None
    if days is not None:
        p = d / f"{ticker}_{days}d.csv"
        return str(p) if p.exists() else None
    # самый свежий
    candidates = sorted(d.glob(f"{ticker}_*.csv"), key=lambda p: p.stat().st_mtime, reverse=True)
    return str(candidates[0]) if candidates else None


def _build_bar_features(rows: list[dict]) -> tuple[list[str], list[list[float]], dict[str, list[float]], list[str]]:
    """
    Возвращает (feature_names, X, fwd_by_col, regimes).
    fwd_by_col: dict {fwd_ret_N: [float, ...]} для всех доступных горизонтов.
    Добавляет log_vol, body_pct, wick_pct к скорам методов.
    """
    method_cols = [c for c in rows[0].keys() if c not in _SKIP_FEATURES]
    feature_names = method_cols + ["log_vol", "body_pct", "wick_pct"]
    avail_fwd = [c for c in _FWD_COLS if c in rows[0]]

    X, regimes = [], []
    fwd_by_col: dict[str, list[float]] = {c: [] for c in avail_fwd}

    for r in rows:
        try:
            vol = float(r["volume"])
            o   = float(r["open"])
            h   = float(r["high"])
            lo  = float(r["low"])
            c   = float(r["close"])
        except (ValueError, KeyError):
            continue

        fwd_vals = {}
        for fc in avail_fwd:
            try:
                fwd_vals[fc] = float(r[fc]) if r.get(fc) else None
            except ValueError:
                fwd_vals[fc] = None

        # пропускаем строку если основной fwd_ret_3 недоступен
        if fwd_vals.get("fwd_ret_3") is None:
            continue

        row_x = []
        ok = True
        for col in method_cols:
            try:
                row_x.append(float(r[col]))
            except (ValueError, KeyError):
                ok = False
                break
        if not ok:
            continue

        row_x.append(math.log1p(vol))
        row_x.append(abs(c - o) / o if o else 0.0)
        row_x.append((h - lo) / o if o else 0.0)

        X.append(row_x)
        regimes.append(r.get("regime", "unknown"))
        for fc in avail_fwd:
            fwd_by_col[fc].append(fwd_vals[fc] if fwd_vals[fc] is not None else 0.0)

    return feature_names, X, fwd_by_col, regimes


# ── Майнинг одного тикера ─────────────────────────────────────────────────────

def mine_ticker(ticker: str, days: int | None, max_depth: int, target: str) -> dict | None:
    csv_path = _find_csv(ticker, days)
    if csv_path is None:
        print(f"{ticker}: CSV не найден в {BAR_SCORES_DIR}/ — пропуск")
        return None

    rows = _load_csv(csv_path)
    if not rows:
        print(f"{ticker}: пустой CSV — пропуск")
        return None

    feature_names, X, fwd_by_col, regimes = _build_bar_features(rows)
    if target not in fwd_by_col or not fwd_by_col[target]:
        # старый CSV без fwd_ret_24/48 — откат к fwd_ret_3
        target = "fwd_ret_3"
    y_all = fwd_by_col[target]

    n_bars = len(X)
    print(f"{ticker}: {n_bars} баров, {len(feature_names)} фичей, цель={target} ({_FWD_LABELS.get(target,'')})")

    # сегментация по режиму
    unique_regimes = sorted(set(regimes))
    result: dict = {
        "ticker": ticker,
        "csv_path": csv_path,
        "computed_at": datetime.now(timezone.utc).date().isoformat(),
        "n_bars": n_bars,
        "max_depth": max_depth,
        "target": target,
        "regimes": {},
        "global": {},
    }

    # глобальный прогон (все режимы вместе)
    tree_g = _build_tree(X, y_all, feature_names, 0, max_depth)
    rules_g: list[dict] = []
    _extract_rules(tree_g, [], rules_g)
    rules_g.sort(key=lambda r: abs(r["avg_fwd_ret"]), reverse=True)
    result["global"] = {
        "n_bars": n_bars,
        "base_avg": round(tree_g.value, 6),
        "rules": rules_g,
    }
    _print_rules(ticker, "ALL", n_bars, tree_g.value, rules_g)

    # per-regime
    for regime in unique_regimes:
        idx = [i for i, rg in enumerate(regimes) if rg == regime]
        if len(idx) < _MIN_REGIME_BARS:
            print(f"  {regime}: {len(idx)} баров < {_MIN_REGIME_BARS} — пропуск")
            continue
        Xr = [X[i] for i in idx]
        yr = [y_all[i] for i in idx]
        tree_r = _build_tree(Xr, yr, feature_names, 0, max_depth)
        rules_r: list[dict] = []
        _extract_rules(tree_r, [], rules_r)
        rules_r.sort(key=lambda r: abs(r["avg_fwd_ret"]), reverse=True)
        result["regimes"][regime] = {
            "n_bars": len(idx),
            "base_avg": round(tree_r.value, 6),
            "rules": rules_r,
        }
        _print_rules(ticker, regime, len(idx), tree_r.value, rules_r)

    return result


def apply_rules_to_csv(rules_data: dict, target_ticker: str, days: int | None = None,
                       target: str | None = None) -> dict | None:
    """
    Применяет правила из rules_data (добытые на одном тикере) к CSV другого тикера.
    Полезно для проверки: работают ли правила акции на её фьючерсе.

    rules_data — результат mine_ticker() или load_rules().
    target_ticker — тикер CSV для проверки (напр. фьючерс AFKSU5).
    target — если None, берётся из rules_data.

    Возвращает dict с той же структурой что mine_ticker, но с ключом
    'applied_from' = исходный тикер и 'applied_to' = target_ticker.
    """
    csv_path = _find_csv(target_ticker, days)
    if csv_path is None:
        print(f"{target_ticker}: CSV не найден — пропуск")
        return None

    rows = _load_csv(csv_path)
    if not rows:
        print(f"{target_ticker}: пустой CSV")
        return None

    target = target or rules_data.get("target", "fwd_ret_3")
    feature_names, X, fwd_by_col, regimes = _build_bar_features(rows)
    if target not in fwd_by_col or not fwd_by_col[target]:
        target = "fwd_ret_3"
    y_all = fwd_by_col[target]
    n_bars = len(X)

    feat_idx = {name: i for i, name in enumerate(feature_names)}

    def _eval_rule(rule: dict, X_seg, y_seg) -> dict | None:
        """Проверяет правило на переданном наборе баров, возвращает статистику."""
        mask = list(range(len(X_seg)))
        for cond in rule["conditions"]:
            # парсим "FEATURE <= 0.1234" или "FEATURE > 0.1234"
            parts = cond.split()
            if len(parts) != 3:
                continue
            fname, op, thresh_s = parts
            if fname not in feat_idx:
                continue
            j = feat_idx[fname]
            thresh = float(thresh_s)
            if op == "<=":
                mask = [i for i in mask if X_seg[i][j] <= thresh]
            elif op == ">":
                mask = [i for i in mask if X_seg[i][j] > thresh]
        if len(mask) < _MIN_LEAF // 2:
            return None
        ys = [y_seg[i] for i in mask]
        return {
            "conditions": rule["conditions"],
            "avg_fwd_ret": round(sum(ys) / len(ys), 6),
            "n_bars": len(ys),
            "orig_avg_fwd_ret": rule["avg_fwd_ret"],
            "depth": rule.get("depth", len(rule["conditions"])),
        }

    result: dict = {
        "ticker": target_ticker,
        "applied_from": rules_data.get("ticker", "?"),
        "applied_to": target_ticker,
        "csv_path": csv_path,
        "computed_at": datetime.now(timezone.utc).date().isoformat(),
        "n_bars": n_bars,
        "target": target,
        "regimes": {},
        "global": {},
    }

    unique_regimes = sorted(set(regimes))

    # global
    base_avg = sum(y_all) / len(y_all) if y_all else 0.0
    global_rules = []
    for rule in rules_data.get("global", {}).get("rules", []):
        r = _eval_rule(rule, X, y_all)
        if r:
            global_rules.append(r)
    global_rules.sort(key=lambda r: abs(r["avg_fwd_ret"]), reverse=True)
    result["global"] = {"n_bars": n_bars, "base_avg": round(base_avg, 6), "rules": global_rules}
    _print_rules(f"{target_ticker}←{rules_data.get('ticker','?')}", "ALL",
                 n_bars, base_avg, global_rules)

    # per-regime
    for regime in unique_regimes:
        idx = [i for i, rg in enumerate(regimes) if rg == regime]
        if len(idx) < _MIN_REGIME_BARS // 2:
            continue
        Xr = [X[i] for i in idx]
        yr = [y_all[i] for i in idx]
        base_r = sum(yr) / len(yr) if yr else 0.0
        src_regime_rules = rules_data.get("regimes", {}).get(regime, {}).get("rules", [])
        regime_rules = []
        for rule in src_regime_rules:
            r = _eval_rule(rule, Xr, yr)
            if r:
                regime_rules.append(r)
        regime_rules.sort(key=lambda r: abs(r["avg_fwd_ret"]), reverse=True)
        result["regimes"][regime] = {"n_bars": len(idx), "base_avg": round(base_r, 6), "rules": regime_rules}
        _print_rules(f"{target_ticker}←{rules_data.get('ticker','?')}", regime,
                     len(idx), base_r, regime_rules)

    return result


def _print_rules(ticker, regime, n, base, rules, top=6):
    print(f"  [{regime}] n={n}, base_avg={base*100:+.3f}%, правил-листьев={len(rules)}")
    for r in rules[:top]:
        cond = " И ".join(r["conditions"])
        print(f"    {cond}")
        print(f"      → avg={r['avg_fwd_ret']*100:+.3f}%  n={r['n_bars']}")


# ── Сохранение / загрузка ─────────────────────────────────────────────────────

def save_rules(ticker: str, data: dict, days: int | None) -> str:
    os.makedirs(BAR_RULES_DIR, exist_ok=True)
    suffix = f"_{days}d" if days else ""
    path = os.path.join(BAR_RULES_DIR, f"{ticker}{suffix}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return path


def load_rules(ticker: str, days: int | None = None) -> dict | None:
    suffix = f"_{days}d" if days else ""
    path = os.path.join(BAR_RULES_DIR, f"{ticker}{suffix}.json")
    if not os.path.exists(path):
        # попробовать без суффикса
        candidates = sorted(Path(BAR_RULES_DIR).glob(f"{ticker}_*.json"),
                            key=lambda p: p.stat().st_mtime, reverse=True)
        if candidates:
            path = str(candidates[0])
        else:
            return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Bar-level rule mining из CSV bar_scores")
    parser.add_argument("tickers", nargs="*", help="тикеры через пробел; или --all")
    parser.add_argument("--all",       action="store_true", help="все CSV из data/bar_scores/")
    parser.add_argument("--days",      type=int,   default=None, help="суффикс CSV (None = самый свежий)")
    parser.add_argument("--max-depth", type=int,   default=_DEFAULT_MAX_DEPTH)
    parser.add_argument("--min-n",     type=int,   default=_MIN_LEAF,
                        help=f"минимум баров в листе (default {_MIN_LEAF})")
    parser.add_argument("--target",    default="fwd_ret_3",
                        choices=list(_FWD_LABELS.keys()), help="целевая переменная")
    parser.add_argument("--apply",     default=None,
                        help="тикер-источник правил (уже посчитан). Применить к --to")
    parser.add_argument("--to",        default=None,
                        help="тикер-цель для --apply (напр. фьючерс)")
    args = parser.parse_args()

    global _MIN_LEAF, _MIN_REGIME_BARS
    _MIN_LEAF = args.min_n
    _MIN_REGIME_BARS = args.min_n * 4

    # режим --apply --to
    if args.apply and args.to:
        src_rules = load_rules(args.apply, args.days)
        if src_rules is None:
            print(f"{args.apply}: правила не найдены, сначала запусти майнер без --apply")
            return
        result = apply_rules_to_csv(src_rules, args.to, args.days, args.target)
        if result:
            path = save_rules(f"{args.to}_from_{args.apply}", result, args.days)
            print(f"  → сохранено: {path}")
        return

    if args.all:
        tickers = sorted(set(
            p.stem.rsplit("_", 1)[0]
            for p in Path(BAR_SCORES_DIR).glob("*.csv")
        ))
    elif args.tickers:
        tickers = args.tickers
    else:
        parser.error("укажи тикеры или --all")
        return

    for i, ticker in enumerate(tickers, 1):
        if len(tickers) > 1:
            print(f"\n[{i}/{len(tickers)}] {ticker}")
        try:
            result = mine_ticker(ticker, args.days, args.max_depth, args.target)
            if result:
                path = save_rules(ticker, result, args.days)
                print(f"  → сохранено: {path}")
        except Exception as e:
            import traceback
            print(f"{ticker}: ошибка — {e}")
            traceback.print_exc()


if __name__ == "__main__":
    main()
