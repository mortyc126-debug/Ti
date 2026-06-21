"""
lasso_calibration.py — еженедельная калибровка начальных/референсных весов
методов через регрессию исхода сделки на скоры методов.

Elastic net (L1+L2) давит на отдельные избыточные методы внутри кластера,
group lasso давит на целые кластеры. Результат — data/lasso_weights.json —
кандидаты на понижение приоритета, но НЕ трогает oi_weights.json (Hedge
per-regime, онлайн, не пересекается).

M1/M2/M3 исключены из фичей: они метамодели над теми же сигналами,
включение создаст двойной счёт как rank-1 фичи.

Кросс-валидация по времени: train на первой половине окна, eval на второй —
тот же walk-forward принцип, что ATR-калибровка, избегает optimizer's curse.

    python lasso_calibration.py SBER --days 90
    python lasso_calibration.py --all --days 90
    python lasso_calibration.py AFKS,AFLT,GAZP --days 90 --alpha 0.05 --l1-ratio 0.7
"""
import argparse
import json
import math
import os
from datetime import datetime, timezone

from tinkoff.invest.exceptions import RequestError

from cluster_models import STRATEGY_CLUSTERS, MODEL_NAMES
from dashboard import _db, _market_data, _strategy_settings_by_ticker, _wire_history
from history import HistoryStore

LASSO_WEIGHTS_FILE = "data/lasso_weights.json"

# Методы-метамодели — исключить из фичей регрессии (двойной счёт)
_EXCLUDE_FROM_FEATURES = set(MODEL_NAMES)  # {"M1_CLUSTER", "M2_CLUSTER", "M3_CLUSTER"}

# {method_id: cluster_label}
_METHOD_TO_CLUSTER = {mid: cl["label"] for cl in STRATEGY_CLUSTERS for mid in cl["ids"]}

# Минимальное кол-во сделок для осмысленной регрессии
MIN_TRADES = 20

# Макс. итераций FISTA
_MAX_ITER = 2000
_TOL = 1e-6


# ── Числовое ядро (numpy-free proximal gradient) ─────────────────────────────

def _dot(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def _mat_vec(X: list[list[float]], w: list[float]) -> list[float]:
    """X @ w, X[n][p], w[p] → y[n]"""
    return [_dot(row, w) for row in X]


def _residuals(y: list[float], yhat: list[float]) -> list[float]:
    return [a - b for a, b in zip(y, yhat)]


def _grad_ls(X: list[list[float]], r: list[float]) -> list[float]:
    """Gradient of (1/2n)||y - Xw||² w.r.t. w = -X^T r / n"""
    n, p = len(X), len(X[0])
    g = [0.0] * p
    inv_n = 1.0 / n
    for i, row in enumerate(X):
        ri = r[i]
        for j in range(p):
            g[j] -= row[j] * ri * inv_n
    return g


def _soft_threshold(x: float, lam: float) -> float:
    if x > lam:
        return x - lam
    if x < -lam:
        return x + lam
    return 0.0


def _norm2(v: list[float]) -> float:
    return math.sqrt(sum(x * x for x in v))


def _lipschitz(X: list[list[float]]) -> float:
    """Оценка липшицевой константы ||X^T X||_op / n через степенной метод."""
    n, p = len(X), len(X[0])
    v = [1.0 / math.sqrt(p)] * p
    for _ in range(30):
        # u = X v
        u = _mat_vec(X, v)
        # v_new = X^T u / n
        nrm = _norm2(u)
        if nrm == 0:
            break
        u = [x / nrm for x in u]
        v_new = [0.0] * p
        for row, ui in zip(X, u):
            for j in range(p):
                v_new[j] += row[j] * ui
        nrm2 = _norm2(v_new)
        v = [x / nrm2 if nrm2 else 0.0 for x in v_new]
    # eigenvalue estimate
    Xv = _mat_vec(X, v)
    return _norm2(Xv) ** 2 / n + 1e-8


def _elastic_net_fista(
    X: list[list[float]], y: list[float],
    alpha: float, l1_ratio: float,
) -> list[float]:
    """FISTA для elastic net: min (1/2n)||y-Xw||² + alpha*(l1_ratio*||w||_1 + (1-l1_ratio)/2*||w||²)"""
    n, p = len(X), len(X[0])
    lam_l1 = alpha * l1_ratio
    lam_l2 = alpha * (1.0 - l1_ratio)
    L = _lipschitz(X) * (1.0 + lam_l2)

    w = [0.0] * p
    z = w[:]
    t = 1.0

    for _ in range(_MAX_ITER):
        yhat = _mat_vec(X, z)
        r = _residuals(y, yhat)
        grad = _grad_ls(X, r)

        # gradient step + L2 shrinkage (ridge folded into step)
        step = 1.0 / L
        w_new = [z[j] - step * (grad[j] + lam_l2 * z[j]) for j in range(p)]
        # L1 soft-threshold
        w_new = [_soft_threshold(w_new[j], step * lam_l1) for j in range(p)]

        t_new = (1.0 + math.sqrt(1.0 + 4.0 * t * t)) / 2.0
        z = [w_new[j] + (t - 1.0) / t_new * (w_new[j] - w[j]) for j in range(p)]

        diff = _norm2([w_new[j] - w[j] for j in range(p)])
        w = w_new
        t = t_new
        if diff < _TOL:
            break

    return w


def _group_lasso_fista(
    X: list[list[float]], y: list[float],
    groups: list[list[int]],
    alpha: float, l1_ratio: float,
) -> list[float]:
    """FISTA с group lasso + elastic net:
    min (1/2n)||y-Xw||² + alpha*l1_ratio*Σ_g√|g|·||w_g||_2 + alpha*(1-l1_ratio)/2·||w||²
    """
    n, p = len(X), len(X[0])
    lam_grp = alpha * l1_ratio
    lam_l2 = alpha * (1.0 - l1_ratio)
    L = _lipschitz(X) * (1.0 + lam_l2)

    w = [0.0] * p
    z = w[:]
    t = 1.0

    for _ in range(_MAX_ITER):
        yhat = _mat_vec(X, z)
        r = _residuals(y, yhat)
        grad = _grad_ls(X, r)

        step = 1.0 / L
        u = [z[j] - step * (grad[j] + lam_l2 * z[j]) for j in range(p)]

        # блочный проксимальный оператор group lasso
        w_new = u[:]
        for g in groups:
            g_norm = _norm2([u[j] for j in g])
            # threshold = step * lam_grp * sqrt(|g|)
            thr = step * lam_grp * math.sqrt(len(g))
            if g_norm <= thr:
                for j in g:
                    w_new[j] = 0.0
            else:
                scale = (g_norm - thr) / g_norm
                for j in g:
                    w_new[j] = u[j] * scale

        t_new = (1.0 + math.sqrt(1.0 + 4.0 * t * t)) / 2.0
        z = [w_new[j] + (t - 1.0) / t_new * (w_new[j] - w[j]) for j in range(p)]

        diff = _norm2([w_new[j] - w[j] for j in range(p)])
        w = w_new
        t = t_new
        if diff < _TOL:
            break

    return w


def _standardize(X: list[list[float]]) -> tuple[list[list[float]], list[float], list[float]]:
    """Центрирование + масштабирование фичей, возвращает (X_std, mean, std)."""
    n, p = len(X), len(X[0])
    means = [sum(X[i][j] for i in range(n)) / n for j in range(p)]
    stds = []
    for j in range(p):
        var = sum((X[i][j] - means[j]) ** 2 for i in range(n)) / n
        stds.append(math.sqrt(var) if var > 1e-12 else 1.0)
    X_std = [[(X[i][j] - means[j]) / stds[j] for j in range(p)] for i in range(n)]
    return X_std, means, stds


def _mse(y: list[float], yhat: list[float]) -> float:
    return sum((a - b) ** 2 for a, b in zip(y, yhat)) / len(y)


# ── Знакочувствительный таргет ────────────────────────────────────────────────

def _signed_outcome(trade: dict) -> float | None:
    """net_pct * знак направления — положительный = прибыль в сторону сигнала.
    Использует mfe/mae: r_multiple-proxy = (mfe - mae) * sign(dir), нормировка
    entry гарантирована, т.к. mfe/mae уже нормированы на entry."""
    mfe = trade.get("mfe")
    mae = trade.get("mae")
    direction = trade.get("dir", "")
    if mfe is None or mae is None or direction not in ("LONG", "SHORT"):
        return None
    sign = 1.0 if direction == "LONG" else -1.0
    return (mfe - mae) * sign


# ── Основной анализ по тикеру ─────────────────────────────────────────────────

def _calibrate_one(
    ticker: str, days: int, alpha: float, l1_ratio: float, use_group_lasso: bool,
) -> dict | None:
    by_ticker = _strategy_settings_by_ticker()
    strategy_settings = by_ticker.get(ticker)
    if strategy_settings is None:
        print(f"{ticker}: нет в settings.ini/oi_tickers.json — пропуск")
        return None

    store = HistoryStore()
    trades = store.get_trades(ticker, window_days=days)
    if not trades:
        print(f"{ticker}: нет сделок в истории — пропуск")
        return None

    # Собрать метод-имена из сделок, исключить метамодели
    all_methods: set[str] = set()
    for t in trades:
        all_methods.update(t.get("method_scores", {}).keys())
    methods = sorted(all_methods - _EXCLUDE_FROM_FEATURES)
    if not methods:
        print(f"{ticker}: нет методов после исключения метамоделей — пропуск")
        return None

    # Построить X, y
    rows_X: list[list[float]] = []
    rows_y: list[float] = []
    for t in trades:
        y_val = _signed_outcome(t)
        if y_val is None:
            continue
        scores = t.get("method_scores", {})
        x_row = [scores.get(m, 0.0) for m in methods]
        rows_X.append(x_row)
        rows_y.append(y_val)

    n = len(rows_y)
    if n < MIN_TRADES:
        print(f"{ticker}: слишком мало сделок ({n} < {MIN_TRADES}) — пропуск")
        return None

    # Кросс-валидация по времени: train=первая половина, eval=вторая
    split = n // 2
    X_train, y_train = rows_X[:split], rows_y[:split]
    X_eval, y_eval = rows_X[split:], rows_y[split:]

    X_train_std, means, stds = _standardize(X_train)
    X_eval_std = [[(X_eval[i][j] - means[j]) / stds[j] for j in range(len(methods))]
                  for i in range(len(X_eval))]

    if use_group_lasso:
        # Построить индексные группы по кластерам
        method_idx = {m: j for j, m in enumerate(methods)}
        groups: list[list[int]] = []
        for cl in STRATEGY_CLUSTERS:
            g = [method_idx[mid] for mid in cl["ids"] if mid in method_idx]
            if g:
                groups.append(g)
        # Методы вне известных кластеров — в одну fallback-группу
        known = {j for g in groups for j in g}
        leftover = [j for j in range(len(methods)) if j not in known]
        if leftover:
            groups.append(leftover)

        w_std = _group_lasso_fista(X_train_std, y_train, groups, alpha, l1_ratio)
    else:
        w_std = _elastic_net_fista(X_train_std, y_train, alpha, l1_ratio)

    # Денормализация: w_orig[j] = w_std[j] / stds[j]
    w_orig = [w_std[j] / stds[j] if stds[j] else 0.0 for j in range(len(methods))]

    # Eval MSE для контроля
    y_hat_eval = _mat_vec(X_eval_std, w_std)
    eval_mse = _mse(y_eval, y_hat_eval)

    coefficients = {m: round(w_orig[j], 6) for j, m in enumerate(methods)}

    # Кластеры с нулевым суммарным весом → dropped
    cluster_weights: dict[str, float] = {}
    for m, coef in coefficients.items():
        cl = _METHOD_TO_CLUSTER.get(m, "?")
        cluster_weights[cl] = cluster_weights.get(cl, 0.0) + abs(coef)
    dropped_clusters = [cl for cl, w in cluster_weights.items() if w < 1e-8]

    figi = strategy_settings.figi
    print(
        f"{ticker} ({figi}): {n} сделок, ненулевых методов: "
        f"{sum(1 for v in coefficients.values() if abs(v) > 1e-8)}/{len(methods)}, "
        f"eval MSE: {eval_mse:.4f}"
    )

    return {
        "computed_at": datetime.now(timezone.utc).date().isoformat(),
        "window_days": days,
        "n_trades": n,
        "alpha": alpha,
        "l1_ratio": l1_ratio,
        "use_group_lasso": use_group_lasso,
        "eval_mse": round(eval_mse, 6),
        "coefficients": coefficients,
        "dropped_clusters": dropped_clusters,
    }


# ── Запись результата ─────────────────────────────────────────────────────────

def _load_existing() -> dict:
    if os.path.exists(LASSO_WEIGHTS_FILE):
        try:
            with open(LASSO_WEIGHTS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save(data: dict) -> None:
    os.makedirs(os.path.dirname(LASSO_WEIGHTS_FILE), exist_ok=True)
    with open(LASSO_WEIGHTS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("ticker", nargs="?",
                        help="один тикер, список через запятую, или --all")
    parser.add_argument("--all", action="store_true",
                        help="прогнать по всем тикерам из settings.ini/oi_tickers.json")
    parser.add_argument("--days", type=int, default=90, help="окно истории сделок")
    parser.add_argument("--alpha", type=float, default=0.01,
                        help="сила регуляризации (elastic net / group lasso)")
    parser.add_argument("--l1-ratio", type=float, default=0.8,
                        help="доля L1 в elastic net (0=ridge, 1=lasso)")
    parser.add_argument("--group-lasso", action="store_true",
                        help="использовать group lasso (блочное обнуление кластеров) "
                             "вместо elastic net")
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

    # Для одного тикера — figi нужен как ключ
    by_ticker = _strategy_settings_by_ticker()

    if len(tickers) == 1:
        ticker = tickers[0]
        try:
            result = _calibrate_one(ticker, args.days, args.alpha, args.l1_ratio, args.group_lasso)
        except RequestError as e:
            print(f"{ticker}: ошибка Tinkoff API ({e.code if hasattr(e, 'code') else e}) — пропуск")
            return
        if result:
            st = by_ticker.get(ticker)
            key = st.figi if st else ticker
            existing[key] = result
            _save(existing)
            print(f"Сохранено → {LASSO_WEIGHTS_FILE} (ключ: {key})")
            _print_result(ticker, result)
        return

    for i, ticker in enumerate(tickers, 1):
        print(f"[{i}/{len(tickers)}]", end=" ")
        try:
            result = _calibrate_one(ticker, args.days, args.alpha, args.l1_ratio, args.group_lasso)
        except RequestError as e:
            print(f"{ticker}: ошибка Tinkoff API ({e.code if hasattr(e, 'code') else e}) — пропуск")
            continue
        except Exception as e:
            print(f"{ticker}: непредвиденная ошибка ({e}) — пропуск")
            continue
        if result:
            st = by_ticker.get(ticker)
            key = st.figi if st else ticker
            existing[key] = result

    _save(existing)
    print(f"\nСохранено → {LASSO_WEIGHTS_FILE} ({len(existing)} тикеров всего)")


def _print_result(ticker: str, result: dict) -> None:
    coefs = result["coefficients"]
    dropped_cl = result["dropped_clusters"]
    rows = sorted(coefs.items(), key=lambda kv: abs(kv[1]), reverse=True)
    print(f"\n{ticker}: коэффициенты регрессии (alpha={result['alpha']}, l1_ratio={result['l1_ratio']})")
    print(f"{'метод':<20} {'кластер':<16} {'коэф.':>10}   статус")
    print("-" * 70)
    for m, c in rows:
        cl = _METHOD_TO_CLUSTER.get(m, "?")
        tag = "  ← обнулён" if abs(c) < 1e-8 else ""
        print(f"{m:<20} {cl:<16} {c:>10.4f}{tag}")
    if dropped_cl:
        print(f"\nОбнулённые кластеры (все методы → 0): {', '.join(dropped_cl)}")
    print(f"eval MSE: {result['eval_mse']:.6f},  n_trades: {result['n_trades']}")


if __name__ == "__main__":
    main()
