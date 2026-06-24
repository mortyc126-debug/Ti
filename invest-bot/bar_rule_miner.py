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

Ускорение: если numpy доступен, _best_split использует
  - np.sort + cumsum для инкрементной дисперсии O(n log n)
  - квантильных кандидатов (20 перцентилей вместо всех уников)
  → ~100-500x быстрее на 50k баров × 50 фичей.

Событийные фильтры (--filter):
  reversals      — только бары локальных экстремумов цены (разворот)
  regime_change  — бары перехода между режимами
  high_vol       — бары с объёмом > 80-й перцентиль
  combined       — объединение всех трёх
  all            — без фильтрации (все бары; дефолт)

apply_rules_to_csv() — применяет правила одного тикера к CSV другого
(напр. правила AFKS → фьючерс AFKSU5).

Использование:
    python bar_rule_miner.py AFKS --days 365
    python bar_rule_miner.py AFKS AFLT SBER --days 365 --target fwd_ret_12
    python bar_rule_miner.py --all --days 365 --max-depth 4 --min-n 100
    python bar_rule_miner.py --apply AFKS --to AFKSU5 --days 365
    python bar_rule_miner.py AFKS --days 365 --filter reversals
    python bar_rule_miner.py AFKS --days 365 --filter combined
"""
import argparse
import csv
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path

try:
    import numpy as np
    _HAS_NUMPY = True
except ImportError:
    _HAS_NUMPY = False

BAR_SCORES_DIR = "data/bar_scores"
BAR_RULES_DIR  = "data/bar_rules"
_DEFAULT_MAX_DEPTH = 4
_MIN_LEAF = 50          # минимум баров в листе
_MIN_REGIME_BARS = 200  # минимум баров режима для сегмента
_FWD_COLS = ("fwd_ret_3", "fwd_ret_6", "fwd_ret_12", "fwd_ret_24", "fwd_ret_48")
_FWD_LABELS = {
    "fwd_ret_3":  "+3 бара (~15м)",
    "fwd_ret_6":  "+6 баров (~30м)",
    "fwd_ret_12": "+12 баров (~1ч)",
    "fwd_ret_24": "+24 бара (~2ч)",
    "fwd_ret_48": "+48 баров (~4ч)",
}
_N_QUANTILE_CANDIDATES = 20  # кандидатов на сплит на фичу (вместо всех уников)

_SKIP_FEATURES = frozenset({
    "time", "open", "high", "low", "close", "volume", "regime",
    *_FWD_COLS,
    "M1_CLUSTER", "M2_CLUSTER", "M3_CLUSTER",
})


# ── CART — numpy-ускоренный путь ──────────────────────────────────────────────

class _Node:
    __slots__ = ("is_leaf", "value", "n", "feature", "threshold", "left", "right")
    def __init__(self):
        self.is_leaf   = True
        self.value     = 0.0
        self.n         = 0
        self.feature   = None
        self.threshold = 0.0
        self.left      = None
        self.right     = None


def _best_split_numpy(X_np, y_np, feature_names):
    """
    O(p * n_q * log n) вместо O(p * n * n).
    X_np: float32 ndarray (n, p), y_np: float64 (n,).
    Квантильные кандидаты (n_q = 20): берём 20 перцентилей по каждой фиче
    вместо всех уникальных значений — важная часть ускорения.
    Инкрементная дисперсия через cumsum — нет O(n) пересортировки на каждый порог.
    """
    n, p = X_np.shape
    y = y_np
    total_var = float(np.var(y)) * n  # sum of squared deviations = var*n

    best_gain  = 0.0
    best_j     = -1
    best_thresh = 0.0

    y_sum   = float(np.sum(y))
    y_sum2  = float(np.dot(y, y))

    quantiles = np.linspace(0, 100, _N_QUANTILE_CANDIDATES + 2)[1:-1]

    for j in range(p):
        col = X_np[:, j]
        thresholds = np.unique(np.percentile(col, quantiles))
        if len(thresholds) < 1:
            continue

        # сортировка по col для incremental sweep
        order = np.argsort(col, kind="stable")
        col_s = col[order]
        y_s   = y[order]

        cum_y  = np.cumsum(y_s)
        cum_y2 = np.cumsum(y_s ** 2)

        for thresh in thresholds:
            # индекс последнего элемента <= thresh
            k = int(np.searchsorted(col_s, thresh, side="right")) - 1
            nl = k + 1
            nr = n - nl
            if nl < _MIN_LEAF or nr < _MIN_LEAF:
                continue

            sl  = float(cum_y[k])
            sl2 = float(cum_y2[k])
            sr  = y_sum  - sl
            sr2 = y_sum2 - sl2

            # var(left)*nl + var(right)*nr = sl2 - sl²/nl + sr2 - sr²/nr
            weighted_var = (sl2 - sl * sl / nl) + (sr2 - sr * sr / nr)
            gain = total_var - weighted_var
            if gain > best_gain:
                best_gain   = gain
                best_j      = j
                best_thresh = float(thresh)

    if best_j < 0:
        return None
    return best_j, best_thresh, best_gain / n  # нормируем как variance reduction


def _best_split_pure(X, y, feature_names):
    """Fallback без numpy. O(n*p*n) — только для малых наборов."""
    n = len(y)
    if n == 0:
        return None
    my = sum(y) / n
    total_var = sum((v - my) ** 2 for v in y)
    best = None
    for j in range(len(feature_names)):
        col = [X[i][j] for i in range(n)]
        uniq = sorted(set(col))
        if len(uniq) < 2:
            continue
        # берём не все уникальные, а квантильные кандидаты
        step = max(1, len(uniq) // _N_QUANTILE_CANDIDATES)
        cands = uniq[step::step]
        for thresh in cands:
            il = [i for i in range(n) if col[i] <= thresh]
            ir = [i for i in range(n) if col[i] >  thresh]
            if len(il) < _MIN_LEAF or len(ir) < _MIN_LEAF:
                continue
            def _var_seg(idx):
                ys = [y[i] for i in idx]
                m = sum(ys) / len(ys)
                return sum((v - m) ** 2 for v in ys)
            gain = total_var - _var_seg(il) - _var_seg(ir)
            if best is None or gain > best[0]:
                best = (gain, j, thresh)
    if best is None or best[0] <= 0:
        return None
    return best[1], best[2], best[0] / n


def _build_tree_numpy(X_np, y_np, feature_names, depth, max_depth):
    node = _Node()
    node.n     = len(y_np)
    node.value = float(np.mean(y_np)) if len(y_np) else 0.0
    if depth >= max_depth or len(y_np) < 2 * _MIN_LEAF:
        return node
    split = _best_split_numpy(X_np, y_np, feature_names)
    if split is None:
        return node
    j, thresh, _ = split
    mask = X_np[:, j] <= thresh
    node.is_leaf   = False
    node.feature   = feature_names[j]
    node.threshold = thresh
    node.left  = _build_tree_numpy(X_np[mask],  y_np[mask],  feature_names, depth+1, max_depth)
    node.right = _build_tree_numpy(X_np[~mask], y_np[~mask], feature_names, depth+1, max_depth)
    return node


def _build_tree_pure(X, y, feature_names, depth, max_depth):
    node = _Node()
    node.n     = len(y)
    node.value = sum(y) / len(y) if y else 0.0
    if depth >= max_depth or len(y) < 2 * _MIN_LEAF:
        return node
    split = _best_split_pure(X, y, feature_names)
    if split is None:
        return node
    j, thresh, _ = split
    il = [i for i in range(len(y)) if X[i][j] <= thresh]
    ir = [i for i in range(len(y)) if X[i][j] >  thresh]
    node.is_leaf   = False
    node.feature   = feature_names[j]
    node.threshold = thresh
    node.left  = _build_tree_pure([X[i] for i in il], [y[i] for i in il], feature_names, depth+1, max_depth)
    node.right = _build_tree_pure([X[i] for i in ir], [y[i] for i in ir], feature_names, depth+1, max_depth)
    return node


def _build_tree(X, y, feature_names, depth, max_depth):
    if _HAS_NUMPY:
        X_np = np.asarray(X, dtype=np.float32)
        y_np = np.asarray(y, dtype=np.float64)
        return _build_tree_numpy(X_np, y_np, feature_names, depth, max_depth)
    return _build_tree_pure(X, y, feature_names, depth, max_depth)


def _extract_rules(node, path, out):
    if node.is_leaf:
        if path:
            out.append({
                "conditions":  list(path),
                "avg_fwd_ret": round(node.value, 6),
                "n_bars":      node.n,
                "depth":       len(path),
            })
        return
    _extract_rules(node.left,  path + [f"{node.feature} <= {node.threshold:.4f}"], out)
    _extract_rules(node.right, path + [f"{node.feature} > {node.threshold:.4f}"],  out)


# ── Событийные фильтры ────────────────────────────────────────────────────────

def _filter_reversals(rows: list[dict], lookback: int = 5) -> list[bool]:
    """
    True на барах локального экстремума (разворот):
      максимум high за lookback назад и вперёд, или минимум low.
    Охватывает конец тренда + начало нового.
    """
    n = len(rows)
    highs = [float(r.get("high", 0) or 0) for r in rows]
    lows  = [float(r.get("low",  0) or 0) for r in rows]
    mask  = [False] * n
    for i in range(lookback, n - lookback):
        win_h = highs[i - lookback: i + lookback + 1]
        win_l = lows [i - lookback: i + lookback + 1]
        if highs[i] == max(win_h) or lows[i] == min(win_l):
            mask[i] = True
    return mask


def _filter_regime_change(rows: list[dict], lookahead: int = 3) -> list[bool]:
    """True на барах смены режима (и lookahead баров после смены)."""
    n = len(rows)
    regimes = [r.get("regime", "") for r in rows]
    mask = [False] * n
    for i in range(1, n):
        if regimes[i] != regimes[i - 1]:
            for k in range(i, min(i + lookahead, n)):
                mask[k] = True
    return mask


def _filter_high_vol(rows: list[dict], percentile: float = 80.0) -> list[bool]:
    """True на барах с объёмом выше заданного перцентиля."""
    vols = []
    for r in rows:
        try:
            vols.append(float(r.get("volume", 0) or 0))
        except ValueError:
            vols.append(0.0)
    if not vols:
        return [False] * len(rows)
    if _HAS_NUMPY:
        threshold = float(np.percentile(vols, percentile))
    else:
        s = sorted(vols)
        idx = int(len(s) * percentile / 100)
        threshold = s[min(idx, len(s) - 1)]
    return [v >= threshold for v in vols]


def apply_event_filter(rows: list[dict], mode: str) -> list[dict]:
    """
    Возвращает подмножество rows согласно event-фильтру.
    mode: 'all' | 'reversals' | 'regime_change' | 'high_vol' | 'combined'
    """
    if mode == "all" or not mode:
        return rows
    n = len(rows)
    if mode == "reversals":
        mask = _filter_reversals(rows)
    elif mode == "regime_change":
        mask = _filter_regime_change(rows)
    elif mode == "high_vol":
        mask = _filter_high_vol(rows)
    elif mode == "combined":
        mr = _filter_reversals(rows)
        mc = _filter_regime_change(rows)
        mh = _filter_high_vol(rows)
        mask = [mr[i] or mc[i] or mh[i] for i in range(n)]
    else:
        return rows
    filtered = [rows[i] for i in range(n) if mask[i]]
    print(f"  фильтр «{mode}»: {sum(mask)}/{n} баров ({100*sum(mask)//n}%)")
    return filtered


# ── Загрузка CSV ──────────────────────────────────────────────────────────────

def _load_csv(path: str) -> list[dict]:
    with open(path, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def _find_csv(ticker: str, days: int | None) -> str | None:
    d = Path(BAR_SCORES_DIR)
    if not d.exists():
        return None
    if days is not None:
        p = d / f"{ticker}_{days}d.csv"
        return str(p) if p.exists() else None
    candidates = sorted(d.glob(f"{ticker}_*.csv"), key=lambda p: p.stat().st_mtime, reverse=True)
    return str(candidates[0]) if candidates else None


def _build_bar_features(rows: list[dict]):
    """
    Возвращает (feature_names, X, fwd_by_col, regimes).
    X — list[list[float]] (конвертируется в ndarray внутри _build_tree).
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

def mine_ticker(ticker: str, days: int | None, max_depth: int, target: str,
                event_filter: str = "all") -> dict | None:
    csv_path = _find_csv(ticker, days)
    if csv_path is None:
        print(f"{ticker}: CSV не найден в {BAR_SCORES_DIR}/ — пропуск")
        return None

    rows = _load_csv(csv_path)
    if not rows:
        print(f"{ticker}: пустой CSV — пропуск")
        return None

    rows = apply_event_filter(rows, event_filter)
    if len(rows) < _MIN_REGIME_BARS:
        print(f"{ticker}: после фильтра осталось {len(rows)} баров < {_MIN_REGIME_BARS} — пропуск")
        return None

    feature_names, X, fwd_by_col, regimes = _build_bar_features(rows)
    if target not in fwd_by_col or not fwd_by_col[target]:
        target = "fwd_ret_3"
    y_all = fwd_by_col[target]

    n_bars = len(X)
    backend = "numpy" if _HAS_NUMPY else "pure-python"
    print(f"{ticker}: {n_bars} баров, {len(feature_names)} фичей, "
          f"цель={target} ({_FWD_LABELS.get(target, '')}), backend={backend}")

    unique_regimes = sorted(set(regimes))
    result: dict = {
        "ticker":      ticker,
        "csv_path":    csv_path,
        "computed_at": datetime.now(timezone.utc).date().isoformat(),
        "n_bars":      n_bars,
        "max_depth":   max_depth,
        "target":      target,
        "event_filter": event_filter,
        "regimes":     {},
        "global":      {},
    }

    tree_g = _build_tree(X, y_all, feature_names, 0, max_depth)
    rules_g: list[dict] = []
    _extract_rules(tree_g, [], rules_g)
    rules_g.sort(key=lambda r: abs(r["avg_fwd_ret"]), reverse=True)
    result["global"] = {
        "n_bars":   n_bars,
        "base_avg": round(tree_g.value, 6),
        "rules":    rules_g,
    }
    _print_rules(ticker, "ALL", n_bars, tree_g.value, rules_g)

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
            "n_bars":   len(idx),
            "base_avg": round(tree_r.value, 6),
            "rules":    rules_r,
        }
        _print_rules(ticker, regime, len(idx), tree_r.value, rules_r)

    return result


def apply_rules_to_csv(rules_data: dict, target_ticker: str, days: int | None = None,
                       target: str | None = None) -> dict | None:
    """Применяет правила из rules_data к CSV другого тикера (напр. акция → фьючерс)."""
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
        mask = list(range(len(X_seg)))
        for cond in rule["conditions"]:
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
            "conditions":        rule["conditions"],
            "avg_fwd_ret":       round(sum(ys) / len(ys), 6),
            "n_bars":            len(ys),
            "orig_avg_fwd_ret":  rule["avg_fwd_ret"],
            "depth":             rule.get("depth", len(rule["conditions"])),
        }

    result: dict = {
        "ticker":       target_ticker,
        "applied_from": rules_data.get("ticker", "?"),
        "applied_to":   target_ticker,
        "csv_path":     csv_path,
        "computed_at":  datetime.now(timezone.utc).date().isoformat(),
        "n_bars":       n_bars,
        "target":       target,
        "regimes":      {},
        "global":       {},
    }

    unique_regimes = sorted(set(regimes))
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

    for regime in unique_regimes:
        idx = [i for i, rg in enumerate(regimes) if rg == regime]
        if len(idx) < _MIN_REGIME_BARS // 2:
            continue
        Xr = [X[i] for i in idx]
        yr = [y_all[i] for i in idx]
        base_r = sum(yr) / len(yr) if yr else 0.0
        src_rules = rules_data.get("regimes", {}).get(regime, {}).get("rules", [])
        regime_rules = []
        for rule in src_rules:
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
    global _MIN_LEAF, _MIN_REGIME_BARS  # объявляем сразу — до использования в default/help
    _min_leaf_default = _MIN_LEAF
    parser = argparse.ArgumentParser(description="Bar-level rule mining из CSV bar_scores")
    parser.add_argument("tickers",     nargs="*", help="тикеры через пробел; или --all")
    parser.add_argument("--all",       action="store_true", help="все CSV из data/bar_scores/")
    parser.add_argument("--days",      type=int,   default=None)
    parser.add_argument("--max-depth", type=int,   default=_DEFAULT_MAX_DEPTH)
    parser.add_argument("--min-n",     type=int,   default=_min_leaf_default,
                        help=f"минимум баров в листе (default {_min_leaf_default})")
    parser.add_argument("--target",    default="fwd_ret_3",
                        choices=list(_FWD_LABELS.keys()))
    parser.add_argument("--filter",    default="all",
                        choices=["all", "reversals", "regime_change", "high_vol", "combined"],
                        help="событийный фильтр баров")
    parser.add_argument("--apply",     default=None,
                        help="тикер-источник правил; применить к --to")
    parser.add_argument("--to",        default=None,
                        help="тикер-цель для --apply")
    args = parser.parse_args()

    _MIN_LEAF = args.min_n
    _MIN_REGIME_BARS = args.min_n * 4

    if _HAS_NUMPY:
        print(f"numpy {np.__version__} — fast CART enabled")
    else:
        print("numpy не найден — используется pure-python CART (медленнее)")

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
            result = mine_ticker(ticker, args.days, args.max_depth, args.target, args.filter)
            if result:
                path = save_rules(ticker, result, args.days)
                print(f"  → сохранено: {path}")
        except Exception as e:
            import traceback
            print(f"{ticker}: ошибка — {e}")
            traceback.print_exc()


if __name__ == "__main__":
    main()
