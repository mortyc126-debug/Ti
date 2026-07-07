"""
lag_analysis.py — измеряет лаг каждого метода из oi_composite_strategy.METHODS
относительно будущего движения цены: кросс-корреляция score(t) с forward
return(t+lag) при разных lag, см. обсуждение "технические индикаторы
структурно запаздывают, микроструктурные (TRADESTATS) — ведущие".

Идея: для каждого lag >= 0 меряется corr(score[t], forward_return[t+lag]).
Если пик |corr| достигается близко к lag=0 — метод реагирует одновременно с
движением или раньше его завершения (ведущий/синхронный); если пик далеко
(близко к --max-lag) — метод "созревает" только после того, как движение
уже состоялось (запаздывающий). Отрицательные lag намеренно не тестируются:
при малом --horizon (по умолчанию 3) окно forward_return для lag < 0 целиком
уходит в прошлое относительно t, и тест измеряет не опережение будущего, а
тривиальную корреляцию score(t) с движением, на котором сам индикатор
посчитан (для трендовых/momentum методов она всегда высокая — это не лаг).

Использует strategy.scan_method_scores() (см. oi_composite_strategy.py) —
непрерывный ряд score по каждому бару (плюс режим bar-by-bar из
regime.classify_regime_probs), а не только в момент сигналов (где лаг уже
скрыт фильтром "score дозрел").

Лаг метода не обязан быть одинаковым во всех режимах рынка (в трендовом
участке технический индикатор может догонять быстрее, чем во флэте/стрессе)
— поэтому профиль считается ОТДЕЛЬНО по каждому режиму, а не только общий.
Это даёт устойчивость к смене характера рынка: веса/триггеры можно тогда
калибровать per-regime, а не одним числом "как сейчас".

    python lag_analysis.py SBER --days 60
    python lag_analysis.py SBER --days 60 --horizon 5   (forward return на N баров)
    python lag_analysis.py --all --days 60              (по всем тикерам settings.ini, агрегат по методам и режимам)
    python lag_analysis.py AFKS,AFLT,GAZP --days 60      (по списку тикеров через запятую, агрегат)
"""
import argparse
import os
import statistics
import sys

# Активируем локальный tinkoff-stub, если реальный SDK не установлен
# (Python 3.14 wheel пока нет). Свечи всё равно берутся из кэша.
_here = os.path.dirname(os.path.abspath(__file__))
if _here not in sys.path:
    sys.path.insert(0, _here)
try:
    import tinkoff.invest  # noqa: F401
except ImportError:
    _stub = os.path.join(_here, "_tinkoff_stub")
    if _stub not in sys.path:
        sys.path.insert(0, _stub)

from tinkoff.invest.exceptions import RequestError

from candle_archive import get_candles_cached
from dashboard import _config, _db, _market_data, _strategy_settings_by_ticker, _wire_history
from regime import REGIMES
from trade_system.strategies.strategy_factory import StrategyFactory

MAX_LAG = 20  # с убранными отрицательными lag реальный лаг трендовых методов может быть больше 10
MIN_REGIME_BARS = 80  # ниже этого regime-специфичный профиль слишком шумный, пропускаем


def _forward_returns(closes: list[float], horizon: int) -> list[float]:
    n = len(closes)
    return [(closes[i + horizon] - closes[i]) / closes[i] if closes[i] and i + horizon < n else None
            for i in range(n)]


def _corrcoef(a: list[float], b: list[float]) -> float:
    if len(a) < 5:
        return 0.0
    try:
        mean_a, mean_b = statistics.fmean(a), statistics.fmean(b)
        cov = sum((x - mean_a) * (y - mean_b) for x, y in zip(a, b))
        var_a = sum((x - mean_a) ** 2 for x in a)
        var_b = sum((y - mean_b) ** 2 for y in b)
        denom = (var_a * var_b) ** 0.5
        return cov / denom if denom else 0.0
    except (ZeroDivisionError, statistics.StatisticsError):
        return 0.0


def _q_to_f(q) -> float:
    """Quotation(units/nano) или уже число → float. Тот же смысл, что _to_f
    в стратегии, но без тяжёлого импорта."""
    try:
        return float(q.units) + float(q.nano) / 1e9
    except AttributeError:
        return float(q)


def _liq_vol(candles: list) -> tuple:
    """Прокси ликвидности и волатильности тикера по свечам: liq — медианный
    барный оборот close·volume (млн), vol — медианный относит. диапазон
    (high-low)/close в %. Медиана — устойчивость к всплескам."""
    turn = []
    rng = []
    for c in candles:
        cl = _q_to_f(c.close)
        if cl <= 0:
            continue
        turn.append(cl * float(c.volume))
        rng.append((_q_to_f(c.high) - _q_to_f(c.low)) / cl)
    if not turn:
        return (None, None)
    return (statistics.median(turn) / 1e6, statistics.median(rng) * 100.0)


def _rank_corr(xs: list[float], ys: list[float]) -> float:
    """Спирмен: Пирсон по рангам. Устойчив к выбросам/нелинейности.
    Если один из рядов константа (нет разброса) — связи нет, 0.0 (иначе
    ранги константы дали бы ложную корреляцию)."""
    if len(set(xs)) < 2 or len(set(ys)) < 2:
        return 0.0

    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        rk = [0.0] * len(v)
        for pos, i in enumerate(order):
            rk[i] = float(pos)
        return rk
    return _corrcoef(ranks(xs), ranks(ys))


def _lag_profile(scores: list[float], fwd_ret: list[float], max_lag: int,
                  regime_mask: list[bool] | None = None) -> dict[int, float]:
    """{lag: corr(score[t], fwd_ret[t+lag])} для lag в [0, max_lag], только
    по барам где regime_mask[t] истинен (если передан). Маска фильтрует по
    исходному индексу t ДО сдвига на lag — лаг остаётся в "настоящих" барах,
    а не в позициях урезанного списка.

    ВАЖНО: lag только >= 0 (т.е. fwd_ret[t+lag], не fwd_ret[t-lag]). При
    отрицательном lag окно forward_return [t+lag, t+lag+horizon] при малом
    horizon (по умолчанию 3) целиком уходит в ПРОШЛОЕ относительно t — тест
    тогда меряет не опережение будущей цены, а тривиальную корреляцию score(t)
    с движением, на котором сам индикатор посчитан (для трендовых/momentum
    методов она всегда высокая и не говорит про лаг). Поэтому "опережение"
    теперь определяется иначе: чем БЛИЖЕ пик |corr| к lag=0, тем более
    ведущий/синхронный метод; чем дальше (ближе к max_lag) — тем больше
    он запаздывает, см. _print_group/_print_aggregate."""
    n = len(scores)
    profile = {}
    for lag in range(0, max_lag + 1):
        s = scores[:n - lag] if lag else scores
        r = fwd_ret[lag:]
        m = regime_mask[:n - lag] if regime_mask is not None else None
        if m is not None:
            pairs = [(x, y) for x, y, keep in zip(s, r, m) if y is not None and keep]
        else:
            pairs = [(x, y) for x, y in zip(s, r) if y is not None]
        if len(pairs) < 10:
            continue
        xs, ys = zip(*pairs)
        profile[lag] = _corrcoef(list(xs), list(ys))
    return profile


# {regime|"_all": {method: (best_lag, corr)}}
TickerResult = dict[str, dict[str, tuple[int, float]]]


def _analyze_one(ticker: str, days: int, horizon: int, max_lag: int) -> tuple:
    """Возвращает (TickerResult|None, (liq, vol))."""
    by_ticker = _strategy_settings_by_ticker()
    strategy_settings = by_ticker.get(ticker)
    if strategy_settings is None:
        print(f"{ticker}: нет в settings.ini/oi_tickers.json — пропуск")
        return None, (None, None)

    try:
        candles = get_candles_cached(ticker, strategy_settings.figi, days, _market_data, _db)
    except RequestError as e:
        print(f"{ticker}: ошибка Tinkoff API ({e.code if hasattr(e, 'code') else e}) — пропуск")
        return None, (None, None)
    if not candles:
        print(f"{ticker}: нет истории свечей — пропуск")
        return None, (None, None)

    liqvol = _liq_vol(candles)

    strategy = StrategyFactory.new_factory(strategy_settings.name, strategy_settings)
    _wire_history(strategy)
    if strategy is None or not hasattr(strategy, "scan_method_scores"):
        print(f"{ticker}: стратегия не поддерживает scan_method_scores — пропуск")
        return None, liqvol

    print(f"Сканирую {ticker}...")
    rows = strategy.scan_method_scores(candles)
    if len(rows) < 30:
        print(f"{ticker}: недостаточно баров ({len(rows)}) — пропуск")
        return None, liqvol

    closes = [r["close"] for r in rows]
    fwd_ret = _forward_returns(closes, horizon)
    method_names = list(rows[0]["scores"].keys())
    regimes = [r.get("regime", "ranging") for r in rows]

    out: TickerResult = {}
    groups = [("_all", None)] + [(r, [g == r for g in regimes]) for r in REGIMES]
    for label, mask in groups:
        if mask is not None and sum(mask) < MIN_REGIME_BARS:
            continue
        per_method: dict[str, tuple[int, float]] = {}
        for method in method_names:
            scores = [r["scores"].get(method, 0.0) for r in rows]
            if all(s == 0.0 for s in scores):
                continue
            profile = _lag_profile(scores, fwd_ret, max_lag, mask)
            if not profile:
                continue
            best_lag = max(profile, key=lambda l: abs(profile[l]))
            per_method[method] = (best_lag, profile[best_lag])
        if per_method:
            out[label] = per_method
    return (out or None), liqvol


def _print_group(title: str, per_method: dict[str, tuple[int, float]]) -> None:
    rows = sorted(per_method.items(), key=lambda kv: kv[1][0], reverse=True)
    print(f"\n{title}")
    print(f"{'метод':<16} {'лаг (бар)':>10} {'corr':>8}   интерпретация")
    print("-" * 60)
    for method, (lag, corr) in rows:
        tag = f"запаздывает на {lag} бар." if lag > 1 else "ведущий/синхронный"
        print(f"{method:<16} {lag:>10} {corr:>8.3f}   {tag}")


def _print_aggregate(per_ticker: dict[str, TickerResult]) -> None:
    """Median-лаг по методу через все тикеры, отдельно по каждому режиму
    (плюс "_all" — общий, без разбивки) — устойчивее к выбросу одного
    тикера/окна, чем смотреть тикеры по отдельности."""
    labels = ["_all"] + list(REGIMES)
    for label in labels:
        by_method: dict[str, list[tuple[int, float]]] = {}
        for result in per_ticker.values():
            for method, (lag, corr) in result.get(label, {}).items():
                by_method.setdefault(method, []).append((lag, corr))
        if not by_method:
            continue
        rows = []
        for method, vals in by_method.items():
            lags = [v[0] for v in vals]
            corrs = [abs(v[1]) for v in vals]
            rows.append((method, statistics.median(lags), statistics.fmean(corrs), len(vals)))
        rows.sort(key=lambda r: r[1], reverse=True)

        title = "ОБЩИЙ (все режимы вместе)" if label == "_all" else f"режим: {label}"
        print(f"\n=== АГРЕГАТ {title} ({len(per_ticker)} тикеров всего, охват по методу — n тикеров) ===")
        print(f"{'метод':<16} {'медиана лага':>13} {'|corr| сред.':>13} {'n тикеров':>10}   интерпретация")
        print("-" * 80)
        for method, med_lag, mean_corr, n in rows:
            tag = f"запаздывает на {med_lag} бар." if med_lag > 1 else "ведущий/синхронный"
            print(f"{method:<16} {med_lag:>13} {mean_corr:>13.3f} {n:>10}   {tag}")


def _print_lag_liquidity(per_ticker: dict, tk_lv: dict, min_tickers: int = 15) -> None:
    """Зависит ли ЛАГ метода от ликвидности тикера? Гипотеза: на ликвидных
    именах микроструктурные методы ведут сильнее (лаг меньше), на неликвидных
    индикаторы запаздывают. По разрезу "_all": Spearman(best_lag, log10 liq) и
    медиана лага в нижней/верхней трети ликвидности."""
    import math
    by_method: dict[str, list[tuple]] = {}
    for tk, result in per_ticker.items():
        liq, vol = tk_lv.get(tk, (None, None))
        if liq is None or liq <= 0:
            continue
        for method, (lag, corr) in result.get("_all", {}).items():
            by_method.setdefault(method, []).append((liq, lag))
    rows = []
    for method, pairs in by_method.items():
        if len(pairs) < min_tickers:
            continue
        liqs = [math.log10(p[0]) for p in pairs]
        lags = [float(p[1]) for p in pairs]
        sp = _rank_corr(liqs, lags)
        srt = sorted(pairs, key=lambda x: x[0])
        t = len(srt) // 3
        lo = [p[1] for p in srt[:t]]
        hi = [p[1] for p in srt[2 * t:]]
        rows.append((method, len(pairs), sp,
                     statistics.median(lo) if lo else None,
                     statistics.median(hi) if hi else None))
    if not rows:
        return
    rows.sort(key=lambda r: r[2])  # сначала сильнее «ведёт на ликвидных» (sp<0)
    print("\n=== зависимость ЛАГА метода от ликвидности тикера (разрез _all) ===")
    print("# Spearman(лаг, log10 ликв): − = на ликвидных лаг меньше (ведёт),")
    print("#  + = на ликвидных лаг больше. lag_lo/lag_hi — медиана лага в")
    print("#  нижней/верхней трети по ликвидности.")
    print(f"{'метод':<16}{'n_tk':>5}{'sp_liq':>8}{'lag_lo':>8}{'lag_hi':>8}  флаг")
    print("-" * 60)
    for method, n, sp, llo, lhi in rows:
        f_sp = f"{sp:+.2f}"
        f_lo = f"{llo:g}" if llo is not None else "—"
        f_hi = f"{lhi:g}" if lhi is not None else "—"
        flag = "ликв-зависимый лаг" if abs(sp) >= 0.3 else ""
        print(f"{method:<16}{n:>5}{f_sp:>8}{f_lo:>8}{f_hi:>8}  {flag}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("ticker", nargs="?", help="один тикер, список через запятую, или используй --all")
    parser.add_argument("--all", action="store_true", help="прогнать по всем тикерам из settings.ini/oi_tickers.json")
    parser.add_argument("--days", type=int, default=60)
    parser.add_argument("--horizon", type=int, default=3, help="forward return на N баров вперёд")
    parser.add_argument("--max-lag", type=int, default=MAX_LAG)
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

    if len(tickers) == 1:
        result, _ = _analyze_one(tickers[0], args.days, args.horizon, args.max_lag)
        if result:
            for label, per_method in result.items():
                title = f"{tickers[0]}: общий (все режимы)" if label == "_all" else f"{tickers[0]}: режим {label}"
                _print_group(title, per_method)
        return

    per_ticker = {}
    tk_lv = {}
    for i, ticker in enumerate(tickers, 1):
        print(f"[{i}/{len(tickers)}]", end=" ")
        try:
            result, liqvol = _analyze_one(ticker, args.days, args.horizon, args.max_lag)
        except Exception as e:
            print(f"{ticker}: непредвиденная ошибка ({e}) — пропуск")
            continue
        if result:
            per_ticker[ticker] = result
            tk_lv[ticker] = liqvol
    if per_ticker:
        _print_aggregate(per_ticker)
        if len(per_ticker) >= 15:
            _print_lag_liquidity(per_ticker, tk_lv)
    else:
        print("Ни один тикер не дал результата.")


if __name__ == "__main__":
    main()
