"""
dashboard.py — браузерный дашборд для прогона виртуальных сделок
(бэктеста) по тикерам из settings.ini, без командной строки.

Логика бэктеста — та же, что в compare_take_stop.py (fixed take/stop vs
ATR-сетка через OICompositeStrategy.backtest_scan_signals/backtest_barriers),
просто доступна через веб-форму с галочками по тикерам.

Если прогон тикера падает с исключением — ошибка не валит всю страницу:
traceback ловится, прогон остальных тикеров продолжается, а к упавшему
тикеру через bug_council.analyze_bug() автоматически прикладывается
AI-диагноз (или просто traceback, если ключа Cerebras нет). Кнопка
«Спросить совет» позволяет так же вручную закинуть любой traceback/лог.

Запуск:  python dashboard.py [--port 8765]
Без внешних зависимостей — только stdlib (http.server) + сам invest-bot.
"""

import argparse
import asyncio
import hmac
import json
import logging
import os

# Гонка процессов в ProcessPoolExecutor: каждый воркер тянет numpy/scipy,
# а BLAS (OpenBLAS/MKL) по умолчанию сам расхватывает все ядра под потоки.
# 4 процесса × N BLAS-тредов на N-ядерной машине = жёсткая оверсаб­скрипция,
# планировщик ОС реально докручивает только 2 из 4 — отсюда "параллелим
# 4, а бежит 2". Ограничиваем BLAS одним тредом на процесс; ставить ДО
# импорта numpy/scipy (в т.ч. транзитивного, через trade_system.*).
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")

import time
import traceback
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from tinkoff.invest.exceptions import RequestError

import bug_council
from archive import ArchiveStore
from calibration import PercentileCalibrator
from candle_archive import get_candles_cached
from configuration.configuration import ProgramConfiguration
from configuration.settings import StrategySettings
from db_api_client import DbApiClient
from history import BacktestHistoryStore
from invest_api.services.instruments_service import InstrumentService
from invest_api.services.market_data_service import MarketDataService
from mega_alerts import MegaAlertsService
from runtime_overrides import load_overrides, save_overrides
from trade_system.issuer_filter import issuer_key, select_top_tickers
from trade_system.strategies.oi_composite_strategy import AUTO_ATR_MIN_TRADES, AUTO_ATR_STOP_KS, AUTO_ATR_TAKE_KS
from trade_system.strategies.strategy_factory import StrategyFactory

CONFIG_FILE = "settings.ini"
LOG_FILE = "dashboard.log"
OI_TICKERS_FILE = "oi_tickers.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=[logging.StreamHandler(), logging.FileHandler(LOG_FILE, encoding="utf-8")],
)
logger = logging.getLogger(__name__)


def _wire_history(strategy) -> None:
    """Подключает History/калибратор к стратегии — без этого __cluster_models
    остаётся None и M1/M2/M3 всегда считают 0 (модели молчат во всех
    бэктестах/портфельных симуляциях дашборда). Используем
    BacktestHistoryStore (не реальный data/history.json — он пуст, бот ещё
    не торговал живьём): стратегия сама строит дневные скоры и attribution
    сделок по ходу сканирования свечей (см. backtest_scan_signals/
    backtest_barriers), так что M1/M2/M3 включаются прямо внутри прогона,
    как только набирается история (≥10 дней)."""
    if hasattr(strategy, "set_history"):
        strategy.set_history(BacktestHistoryStore(), PercentileCalibrator())


_config = ProgramConfiguration(CONFIG_FILE)
_market_data = MarketDataService(_config.tinkoff_token, _config.tinkoff_app_name)
_instrument_service = InstrumentService(_config.tinkoff_token, _config.tinkoff_app_name)
_mega_alerts = MegaAlertsService()
_db = DbApiClient(_config.mega_alerts_settings.db_api_url, _config.mega_alerts_settings.db_api_key)
_archive = ArchiveStore()

# Скан __compute_composite() на каждом баре (Hawkes-MLE через scipy.optimize)
# — CPU-bound, кэш свечей тут не помогает. Гоняем тикеры параллельно по
# процессам (не по тредам — GIL не отпускается на каждой scipy-итерации).
BACKTEST_WORKERS = int(os.getenv("BACKTEST_WORKERS", "4"))

# Дефолтные настройки сигнала для тикеров, импортированных из OI (у них
# нет [STRATEGY_<TICKER>] в settings.ini — только тикер+FIGI) — берём те же
# значения, что у MEGA_ALERTS в settings.ini.
_OI_DEFAULT_SETTINGS = {
    "SIGNAL_THRESHOLD": _config.mega_alerts_settings.signal_threshold,
    "LONG_TAKE": _config.mega_alerts_settings.long_take,
    "LONG_STOP": _config.mega_alerts_settings.long_stop,
    "SHORT_TAKE": _config.mega_alerts_settings.short_take,
    "SHORT_STOP": _config.mega_alerts_settings.short_stop,
}


def get_auto_atr_snapshot() -> list[dict]:
    """
    Последние авто-подобранные ATR_TAKE_K/ATR_STOP_K по тикерам (из
    data/archive.json, пишет Trader.__archive_today — см. oi_composite_strategy.py
    __recalc_auto_atr). Только тикеры, где живой бот уже считал авто-ATR
    (явные ATR_TAKE_K/ATR_STOP_K в settings.ini подбор не запускают).
    """
    rows = []
    for ticker in _archive.tickers():
        history = _archive.history(ticker)
        if not history:
            continue
        last_date = max(history.keys())
        snap = history[last_date]
        tk, sk = snap.get("auto_atr_take_k"), snap.get("auto_atr_stop_k")
        if tk is None or sk is None:
            continue
        rows.append({"ticker": ticker, "date": last_date, "auto_atr_take_k": tk, "auto_atr_stop_k": sk})
    rows.sort(key=lambda r: r["ticker"])
    return rows


def load_oi_tickers() -> dict:
    """{ticker: {figi, name}} — тикеры, импортированные из экспорта oi-signal-v10.html."""
    if not os.path.exists(OI_TICKERS_FILE):
        return {}
    with open(OI_TICKERS_FILE, encoding="utf-8") as f:
        return json.load(f)


def merge_oi_tickers(oi_tickers: list[dict], signal_log: list[dict] | None = None) -> int:
    """
    Принимает массив `tickers` из JSON-экспорта OI ({t, f, name, ...} —
    см. exportData() в oi-signal-v10.html), сохраняет тикер+FIGI на диск.
    `signal_log` (тоже из экспорта OI) — считаем по нему demand =
    частоту сигналов по тикеру, нужна для дедупликации по эмитенту
    (см. trade_system/issuer_filter.py) — самый востребованный из пары
    "обычка/префы" остаётся, второй — нет.
    Возвращает число добавленных/обновлённых тикеров.
    """
    current = load_oi_tickers()
    demand_counts: dict[str, int] = defaultdict(int)
    for entry in signal_log or []:
        t = entry.get("ticker")
        if t:
            demand_counts[t] += 1

    n = 0
    for item in oi_tickers:
        ticker = item.get("t")
        figi = item.get("f")
        if not ticker or not figi:
            continue
        current[ticker] = {
            "figi": figi, "name": item.get("name", ticker),
            "demand": demand_counts.get(ticker, current.get(ticker, {}).get("demand", 0)),
        }
        n += 1
    with open(OI_TICKERS_FILE, "w", encoding="utf-8") as f:
        json.dump(current, f, ensure_ascii=False, indent=2)
    return n


def _strategy_settings_by_ticker() -> dict:
    """Тикеры из settings.ini + импортированные из OI (с дефолтными настройками сигнала)."""
    by_ticker = {s.ticker: s for s in _config.trade_strategy_settings}
    for ticker, info in load_oi_tickers().items():
        if ticker in by_ticker:
            continue
        by_ticker[ticker] = StrategySettings(
            name="OICompositeStrategy", figi=info["figi"], ticker=ticker,
            settings=dict(_OI_DEFAULT_SETTINGS),
        )
    return by_ticker


def filter_active_tickers(tickers: list[str], dedup_by_issuer: bool, top_pct: float) -> dict:
    """
    Применяет дедуп по эмитенту + отсев по востребованности (см.
    issuer_filter.select_top_tickers) к выбранному в UI списку тикеров.

    Тикеры из settings.ini (вручную отобранные, без дублей) всегда
    остаются — demand у них приравнивается к "бесконечности", чтобы они
    не вытеснялись и не отсекались top_pct, но всё равно участвовали в
    дедупе как "сильный" вариант, если у эмитента есть OI-дубль.
    """
    if not dedup_by_issuer:
        return {"kept": tickers, "dropped": []}

    settings_tickers = {s.ticker for s in _config.trade_strategy_settings}
    oi_tickers = load_oi_tickers()

    infos = []
    for ticker in tickers:
        if ticker in settings_tickers:
            infos.append({"ticker": ticker, "issuer_key": issuer_key(ticker), "demand": float("inf")})
        else:
            info = oi_tickers.get(ticker, {})
            infos.append({
                "ticker": ticker,
                "issuer_key": issuer_key(ticker, info.get("name", "")),
                "demand": info.get("demand", 0),
            })

    kept, dropped = select_top_tickers(infos, top_pct)
    kept_set = set(tickers) & set(kept)
    return {"kept": [t for t in tickers if t in kept_set], "dropped": dropped}


def fetch_mega_alert_tickers() -> dict:
    """
    Подтягивает сегодняшние аномалии MOEX MEGA-ALERTS (alerts.json по
    всему рынку, нужен MOEX_TOKEN — см. mega_alerts.py) и добавляет их
    в oi_tickers.json, чтобы они появились в чекбоксах дашборда и
    участвовали в бэктесте/портфельной симуляции — тот же набор данных,
    которым в реальной торговле пользуется Trader (см.
    trade_day -> __dedup_mega_alerts_candidates в trading/trader.py).

    Дедуп по эмитенту против уже сконфигурированных тикеров — той же
    логикой, что и в живой торговле (issuer_filter.select_top_tickers),
    чтобы дашборд видел тот же список кандидатов, что и бот.
    """
    try:
        asyncio.run(_mega_alerts.refresh_once())
    except Exception as ex:
        logger.warning(f"mega_alerts: обновление не удалось: {ex}")

    configured = set(_strategy_settings_by_ticker().keys())
    raw = [t for t in _mega_alerts.tickers_today("eq") if t not in configured]
    configured_keys = {issuer_key(t) for t in configured}
    infos = [
        {"ticker": t, "issuer_key": issuer_key(t), "demand": len(raw) - i}
        for i, t in enumerate(raw) if issuer_key(t) not in configured_keys
    ]
    kept, dropped = select_top_tickers(infos, top_pct=1.0)

    added: list[dict] = []
    unresolved: list[str] = []
    for ticker in kept:
        resolved = _instrument_service.share_by_ticker(ticker)
        if not resolved:
            unresolved.append(ticker)
            continue
        _, figi = resolved
        added.append({"t": ticker, "f": figi, "name": ticker})

    n = merge_oi_tickers(added)
    return {"added": [a["t"] for a in added], "dropped": dropped, "unresolved": unresolved, "n": n}


def run_backtest_one(
        ticker: str, days: int, atr_take_ks: list[float], atr_stop_ks: list[float],
        tariff: str | None = None,
) -> list[dict]:
    """
    Прогоняет бэктест по одному тикеру. Возвращает список строк-результатов
    (как в compare_take_stop.py: fixed + лучшая ATR-комбинация),
    либо строку с ошибкой и советом, если тикер упал.
    """
    by_ticker = _strategy_settings_by_ticker()
    rows: list[dict] = []

    strategy_settings = by_ticker.get(ticker)
    if strategy_settings is None:
        rows.append({"ticker": ticker, "mode": "ошибка", "error": "нет в settings.ini"})
        return rows

    t0 = time.monotonic()
    logger.info(f"{ticker}: получаю историю свечей ({days} дн.)...")
    try:
        strategy = StrategyFactory.new_factory(strategy_settings.name, strategy_settings)
        _wire_history(strategy)
        if strategy is None or not hasattr(strategy, "backtest_barriers"):
            rows.append({"ticker": ticker, "mode": "пропуск",
                         "error": "стратегия не поддерживает backtest_barriers"})
            return rows

        try:
            candles = get_candles_cached(ticker, strategy_settings.figi, days, _market_data, _db)
        except RequestError as ex:
            rows.append({"ticker": ticker, "mode": "ошибка API", "error": str(ex.details)})
            return rows

        if not candles:
            rows.append({"ticker": ticker, "mode": "нет истории", "error": ""})
            return rows

        logger.info(f"{ticker}: {len(candles)} свечей за {time.monotonic() - t0:.1f}с, считаю сигналы "
                    f"(может занять минуту-две — внутри Hawkes-MLE на каждый бар)...")
        s = strategy_settings.settings
        long_take = Decimal(s.get("LONG_TAKE", "1.015"))
        long_stop = Decimal(s.get("LONG_STOP", "0.985"))

        t1 = time.monotonic()
        signals = strategy.backtest_scan_signals(candles)
        logger.info(f"{ticker}: {len(signals)} сигналов, скан занял {time.monotonic() - t1:.1f}с")

        fixed = strategy.backtest_barriers(signals=signals, take_mult=long_take, stop_mult=long_stop, tariff=tariff)
        rows.append({"ticker": ticker, "mode": "fixed", **fixed})

        best = None
        for tk in atr_take_ks:
            for sk in atr_stop_ks:
                res = strategy.backtest_barriers(signals=signals, atr_take_k=tk, atr_stop_k=sk, tariff=tariff)
                if res["n_trades"] == 0:
                    continue
                if best is None or res["expectancy_pct"] > best[1]["expectancy_pct"]:
                    best = ((tk, sk), res)

        if best:
            (tk, sk), res = best
            rows.append({"ticker": ticker, "mode": f"ATR k={tk}/{sk}", **res})

    except Exception:
        tb = traceback.format_exc()
        context = (f"dashboard run_backtest: ticker={ticker}, days={days}, "
                   f"atr_take={atr_take_ks}, atr_stop={atr_stop_ks}")
        advice = bug_council.analyze_bug(tb, context)
        logger.error(f"run_backtest {ticker}:\n{tb}")
        rows.append({"ticker": ticker, "mode": "ошибка", "error": tb.strip().splitlines()[-1],
                     "traceback": tb, "advice": advice})

    return rows


def run_backtest(
        tickers: list[str], days: int, atr_take_ks: list[float], atr_stop_ks: list[float],
        tariff: str | None = None,
) -> list[dict]:
    """
    Прогоняет бэктест по всем тикерам сразу (используется как fallback API).
    Каждый тикер — это независимый дорогой CPU-bound скан (Hawkes-MLE на
    каждый бар), поэтому гоняем по процессам параллельно, а не по очереди.
    """
    if len(tickers) <= 1:
        rows: list[dict] = []
        for ticker in tickers:
            rows.extend(run_backtest_one(ticker, days, atr_take_ks, atr_stop_ks, tariff=tariff))
        return rows

    by_ticker_rows: dict[str, list[dict]] = {}
    with ProcessPoolExecutor(max_workers=min(BACKTEST_WORKERS, len(tickers))) as pool:
        futures = {
            pool.submit(run_backtest_one, ticker, days, atr_take_ks, atr_stop_ks, tariff): ticker
            for ticker in tickers
        }
        for fut in as_completed(futures):
            ticker = futures[fut]
            by_ticker_rows[ticker] = fut.result()

    rows = []
    for ticker in tickers:
        rows.extend(by_ticker_rows.get(ticker, []))
    return rows


def _portfolio_sim_one_ticker(
        ticker: str, days: int, tariff: str | None,
        mode: str, atr_take_ks: list[float] | None, atr_stop_ks: list[float] | None,
) -> tuple[list[dict], dict | None]:
    """Считает сделки одного тикера для портфельной симуляции. Выделено в
    отдельную функцию, чтобы гонять тикеры параллельно по процессам
    (см. run_portfolio_sim) — каждый скан CPU-bound сам по себе."""
    by_ticker = _strategy_settings_by_ticker()
    strategy_settings = by_ticker.get(ticker)
    if strategy_settings is None:
        return [], {"ticker": ticker, "error": "нет в settings.ini и не импортирован из OI"}
    try:
        strategy = StrategyFactory.new_factory(strategy_settings.name, strategy_settings)
        _wire_history(strategy)
        if strategy is None or not hasattr(strategy, "backtest_barriers"):
            return [], None

        try:
            candles = get_candles_cached(ticker, strategy_settings.figi, days, _market_data, _db)
        except RequestError as ex:
            return [], {"ticker": ticker, "error": str(ex.details)}
        if not candles:
            return [], None

        signals = strategy.backtest_scan_signals(candles)
        trades: list[dict] = []

        if mode == "atr":
            if not signals:
                return [], None
            # Раньше тут был один sweep по ВСЕЙ истории тикера — лучшая по
            # expectancy_pct пара (tk, sk) подбиралась по тем же сделкам,
            # что потом шли в отчёт (look-ahead/переподгонка). Здесь —
            # пересчёт раз в день только по сигналам ДО этого дня, как в
            # проде (см. __recalc_auto_atr): честная имитация того, что
            # увидел бы живой бот, без подглядывания в свои будущие сделки.
            grid_take = list(atr_take_ks or AUTO_ATR_TAKE_KS)
            grid_stop = list(atr_stop_ks or AUTO_ATR_STOP_KS)
            by_day: dict = defaultdict(list)
            for sig in signals:
                et = sig["entry_time"]
                day = et.date() if hasattr(et, "date") else str(et)[:10]
                by_day[day].append(sig)

            chosen_k = (grid_take[len(grid_take) // 2], grid_stop[len(grid_stop) // 2])
            past_signals: list[dict] = []
            for day in sorted(by_day.keys()):
                day_signals = by_day[day]
                if len(past_signals) >= AUTO_ATR_MIN_TRADES:
                    best = None
                    for tk in grid_take:
                        for sk in grid_stop:
                            r = strategy.backtest_barriers(signals=past_signals, atr_take_k=tk, atr_stop_k=sk,
                                                            tariff=tariff)
                            if r["n_trades"] < AUTO_ATR_MIN_TRADES:
                                continue
                            if best is None or r["expectancy_pct"] > best[1]:
                                best = ((tk, sk), r["expectancy_pct"])
                    if best is not None:
                        chosen_k = best[0]
                tk, sk = chosen_k
                res = strategy.backtest_barriers(signals=day_signals, atr_take_k=tk, atr_stop_k=sk,
                                                  return_trades=True, tariff=tariff)
                for t in res.get("trades", []):
                    t["ticker"] = ticker
                    t["atr_k"] = f"{tk}/{sk}"
                    trades.append(t)
                past_signals.extend(day_signals)
        else:
            s = strategy_settings.settings
            long_take = Decimal(s.get("LONG_TAKE", "1.015"))
            long_stop = Decimal(s.get("LONG_STOP", "0.985"))
            res = strategy.backtest_barriers(signals=signals, take_mult=long_take, stop_mult=long_stop,
                                              return_trades=True, tariff=tariff)
            for t in res.get("trades", []):
                t["ticker"] = ticker
                trades.append(t)

        return trades, None

    except Exception:
        tb = traceback.format_exc()
        advice = bug_council.analyze_bug(tb, f"dashboard run_portfolio_sim: ticker={ticker}, days={days}")
        logger.error(f"run_portfolio_sim {ticker}:\n{tb}")
        return [], {"ticker": ticker, "error": tb.strip().splitlines()[-1], "traceback": tb, "advice": advice}


def run_portfolio_sim(
        tickers: list[str], days: int, account: float, risk_pct: float, tariff: str | None = None,
        mode: str = "atr", atr_take_ks: list[float] | None = None, atr_stop_ks: list[float] | None = None,
) -> dict:
    """
    Виртуальный счёт: сделки со ВСЕХ выбранных тикеров сводятся в одну
    хронологию и проигрываются по очереди на одном балансе — как если бы
    счёт был один, а сигналы приходили вперемешку.

    mode="fixed" — take/stop из настроек тикера (как раньше). mode="atr" —
    на каждом тикере для тех же сигналов подбирается лучшая по expectancy_pct
    комбинация ATR_TAKE_K/ATR_STOP_K из сетки (как в run_backtest_one) и
    именно её сделки идут в портфель. Нужно, чтобы сравнить плавающий
    take/stop с фиксированным не только по отдельному тикеру (как в таблице
    бэктеста), но и на одном виртуальном счёте.

    Размер сделки — risk_pct% от ТЕКУЩЕГО баланса (растёт/падает вместе со
    счётом), а не от стартового — иначе просадка/рост считались бы нечестно.
    pnl сделки = риск_в_рублях × r_multiple (R-мультипликатор уже учитывает
    комиссию, см. backtest_barriers).

    Каждый тикер сканится независимо (дорогой Hawkes-MLE per-bar) — гоняем
    параллельно по процессам, а не по очереди (см. run_backtest).
    """
    all_trades: list[dict] = []
    errors: list[dict] = []

    if len(tickers) <= 1:
        results = [(t, _portfolio_sim_one_ticker(t, days, tariff, mode, atr_take_ks, atr_stop_ks))
                   for t in tickers]
    else:
        results = []
        with ProcessPoolExecutor(max_workers=min(BACKTEST_WORKERS, len(tickers))) as pool:
            futures = {
                pool.submit(_portfolio_sim_one_ticker, ticker, days, tariff, mode, atr_take_ks, atr_stop_ks): ticker
                for ticker in tickers
            }
            for fut in as_completed(futures):
                results.append((futures[fut], fut.result()))

    for ticker, (trades, error) in results:
        all_trades.extend(trades)
        if error:
            errors.append(error)

    all_trades.sort(key=lambda t: t["entry_time"])

    equity = account
    peak = account
    max_dd = 0.0
    by_ticker_stats: dict = defaultdict(lambda: {"n": 0, "wins": 0, "pnl_rub": 0.0})
    monthly: dict = defaultdict(lambda: {"n": 0, "pnl_rub": 0.0, "equity_end": account})
    trade_rows: list[dict] = []
    # Та же логика agree/disagree, что в backtest_barriers.model_stats, но
    # по сводным сделкам портфеля (все тикеры вместе) — отдельный прогон
    # по тикеру может не показать характер модели на малой выборке.
    model_tally = {
        m: {"agree_n": 0, "agree_win": 0, "agree_dur": 0.0, "disagree_n": 0, "disagree_win": 0, "disagree_dur": 0.0}
        for m in ("m1", "m2", "m3")
    }

    for t in all_trades:
        dir_sign = 1 if t["direction"] == "LONG" else -1
        dur = t.get("duration_min", 0.0)
        for m in ("m1", "m2", "m3"):
            m_sc = t.get(m, 0.0)
            if m_sc == 0:
                continue
            tally = model_tally[m]
            if (m_sc > 0) == (dir_sign > 0):
                tally["agree_n"] += 1
                tally["agree_win"] += int(t["win"])
                tally["agree_dur"] += dur
            else:
                tally["disagree_n"] += 1
                tally["disagree_win"] += int(t["win"])
                tally["disagree_dur"] += dur
        risk_rub = equity * risk_pct / 100.0
        pnl_rub = risk_rub * t["r_multiple"]
        equity += pnl_rub
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)

        month_key = t["entry_time"].strftime("%Y-%m") if hasattr(t["entry_time"], "strftime") \
            else str(t["entry_time"])[:7]
        m = monthly[month_key]
        m["n"] += 1
        m["pnl_rub"] += pnl_rub
        m["equity_end"] = round(equity, 2)

        bt = by_ticker_stats[t["ticker"]]
        bt["n"] += 1
        bt["wins"] += 1 if t["win"] else 0
        bt["pnl_rub"] += pnl_rub

        trade_rows.append({
            "ticker": t["ticker"], "entry_time": str(t["entry_time"]), "direction": t["direction"],
            "net_pct": round(t["net_pct"], 4), "r_multiple": round(t["r_multiple"], 2),
            "pnl_rub": round(pnl_rub, 2), "equity_after": round(equity, 2),
            "m1": round(t.get("m1", 0.0), 3), "m2": round(t.get("m2", 0.0), 3), "m3": round(t.get("m3", 0.0), 3),
        })

    per_ticker = [
        {"ticker": tk, "n_trades": v["n"], "win_rate": round(v["wins"] / v["n"], 3) if v["n"] else 0.0,
         "pnl_rub": round(v["pnl_rub"], 2)}
        for tk, v in sorted(by_ticker_stats.items())
    ]
    monthly_rows = [
        {"month": mk, "n_trades": v["n"], "pnl_rub": round(v["pnl_rub"], 2), "equity_end": v["equity_end"]}
        for mk, v in sorted(monthly.items())
    ]

    model_stats = {
        m.upper() + "_CLUSTER": {
            "agree_n": t["agree_n"],
            "agree_win_rate": t["agree_win"] / t["agree_n"] if t["agree_n"] else None,
            "agree_avg_duration_min": round(t["agree_dur"] / t["agree_n"], 1) if t["agree_n"] else None,
            "disagree_n": t["disagree_n"],
            "disagree_win_rate": t["disagree_win"] / t["disagree_n"] if t["disagree_n"] else None,
            "disagree_avg_duration_min": round(t["disagree_dur"] / t["disagree_n"], 1) if t["disagree_n"] else None,
        }
        for m, t in model_tally.items()
    }

    # "Что если бы" сценарии: тот же портфель сделок (хронология/риск как
    # выше), но из них отбираются только те, где соответствующая модель
    # согласна с направлением сделки — показывает, ухудшил бы реальный
    # композит результат, если бы M1/M2/M3 решали сами (или все втроём).
    def _simulate(subset: list[dict]) -> dict:
        eq, pk, dd = account, account, 0.0
        for tt in subset:
            risk = eq * risk_pct / 100.0
            eq += risk * tt["r_multiple"]
            pk = max(pk, eq)
            dd = max(dd, pk - eq)
        return {"n_trades": len(subset), "equity_end": round(eq, 2), "pnl_rub": round(eq - account, 2),
                "max_drawdown_rub": round(dd, 2)}

    what_if = {}
    for m in ("m1", "m2", "m3"):
        subset = [tt for tt in all_trades if tt.get(m, 0.0) != 0
                  and (tt.get(m, 0.0) > 0) == (tt["direction"] == "LONG")]
        what_if[m.upper() + "_CLUSTER_ONLY"] = _simulate(subset)
    all_agree = [
        tt for tt in all_trades
        if all(tt.get(m, 0.0) != 0 and (tt.get(m, 0.0) > 0) == (tt["direction"] == "LONG")
               for m in ("m1", "m2", "m3"))
    ]
    what_if["ALL_THREE_AGREE"] = _simulate(all_agree)
    two_of_three = [
        tt for tt in all_trades
        if sum(tt.get(m, 0.0) != 0 and (tt.get(m, 0.0) > 0) == (tt["direction"] == "LONG")
               for m in ("m1", "m2", "m3")) >= 2
    ]
    what_if["TWO_OF_THREE_AGREE"] = _simulate(two_of_three)

    return {
        "summary": {
            "account_start": account, "equity_end": round(equity, 2),
            "pnl_rub": round(equity - account, 2), "max_drawdown_rub": round(max_dd, 2),
            "n_trades": len(all_trades),
        },
        "monthly": monthly_rows,
        "per_ticker": per_ticker,
        "trades": trade_rows,
        "model_stats": model_stats,
        "what_if": what_if,
        "errors": errors,
    }


PAGE_HTML = """<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>invest-bot · DASHBOARD — виртуальные сделки</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Unbounded:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{{box-sizing:border-box;margin:0;padding:0;}}
:root{{
  --bg:#0B0613;--panel:#140A24;--card:#1A1030;
  --accent:#FF006E;--accent2:#FF2A8A;
  --pos:#52F2C9;--neg:#FF4D7A;--mem:#A78BFA;--warn:#FF9F40;
  --txt:#F2F0FF;--txt2:#A79BC9;--txt3:#6F648F;
  --border:rgba(255,0,128,0.12);--border2:rgba(170,90,255,0.10);
}}
body{{background:linear-gradient(180deg,#0A0615 0%,#0D0718 35%,#12091F 100%);min-height:100vh;font-family:'JetBrains Mono',monospace;color:var(--txt);padding:14px 16px;}}
.hdr{{display:flex;align-items:flex-start;gap:10px;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--border2);flex-wrap:wrap;}}
.logo{{font-family:'Unbounded',sans-serif;font-size:13px;font-weight:700;color:var(--accent);text-shadow:0 0 20px rgba(255,0,110,0.35);white-space:nowrap;}}
.logo-sub{{font-size:9px;color:var(--txt3);letter-spacing:.08em;margin-top:2px;}}
.panel{{background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:14px;margin-bottom:16px;}}
.sec{{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--txt3);margin-bottom:10px;}}
label{{display:inline-block;margin:4px 12px 4px 0;font-size:11px;color:var(--txt2);}}
.inp{{background:var(--panel);border:1px solid var(--border);border-radius:999px;padding:6px 14px;color:var(--txt2);font-family:'JetBrains Mono',monospace;font-size:11px;outline:none;}}
.inp:focus{{border-color:rgba(255,0,110,.4);}}
.inp.mid{{width:100px;}}
.btn-pill{{background:linear-gradient(180deg,rgba(255,0,128,.22),rgba(255,0,128,.12));border:1px solid rgba(255,0,128,.5);border-radius:999px;color:var(--accent);font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;letter-spacing:.06em;padding:8px 18px;cursor:pointer;transition:all .15s;}}
.btn-pill:hover{{box-shadow:0 0 14px rgba(255,0,128,.25);}}
.chips{{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px;}}
.chip{{display:flex;align-items:center;gap:1px;padding:5px 12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:999px;cursor:pointer;transition:all .15s;font-size:11px;font-weight:600;color:var(--txt);}}
.chip:hover{{border-color:rgba(255,0,128,.25);}}
.chip.active{{background:linear-gradient(180deg,rgba(255,0,128,.18),rgba(255,0,128,.08));border-color:rgba(255,0,128,.45);color:var(--accent);}}
.scen-table{{width:100%;border-collapse:collapse;font-size:11px;margin-top:10px;}}
.scen-table th{{text-align:right;color:var(--txt3);font-weight:400;padding:5px 8px;border-bottom:1px solid rgba(255,255,255,.08);}}
.scen-table th:first-child, .scen-table td:first-child{{text-align:left;}}
.scen-table td{{padding:5px 8px;border-bottom:1px solid rgba(255,255,255,.03);color:var(--txt2);text-align:right;}}
.scen-table tr:hover td{{background:rgba(255,255,255,.02);}}
.sdot{{width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:4px;vertical-align:middle;}}
.sdot.ok{{background:var(--pos);box-shadow:0 0 7px rgba(82,242,201,.5);}}
.sdot.err{{background:var(--neg);box-shadow:0 0 7px rgba(255,77,122,.5);}}
.err{{color:var(--neg);}}
.advice{{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:10px 12px;margin-top:4px;font-size:11px;white-space:pre-wrap;color:var(--txt2);}}
.advice b{{color:var(--mem);}}
textarea{{width:100%;height:140px;background:var(--panel);color:var(--txt);border:1px solid var(--border);border-radius:14px;font-family:'JetBrains Mono',monospace;font-size:11px;padding:10px;}}
#status{{font-size:11px;color:var(--txt3);margin-left:10px;}}
</style>
</head>
<body>
<div class="hdr">
  <div>
    <div class="logo">INVEST-BOT · DASHBOARD</div>
    <div class="logo-sub">VIRTUAL TRADES BACKTEST &amp; BUG COUNCIL</div>
  </div>
</div>

<div class="panel">
  <div class="sec">Бэктест</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:8px;">
    Список тикеров — из settings.ini + импортированные из OI.
    <input type="file" id="oiFile" accept="application/json" style="display:none" onchange="importOiFile(event)">
    <button class="btn-pill" style="padding:4px 12px;font-size:10px;" onclick="document.getElementById('oiFile').click()">↓ Импорт из OI</button>
    <button class="btn-pill" style="padding:4px 12px;font-size:10px;" onclick="fetchMegaAlerts()">🔥 Аномалии MOEX</button>
    <span id="oi_status"></span>
  </div>
  <div class="chips" id="tickers">{ticker_checkboxes}</div>
  <label>Дней истории <input type="number" class="inp mid" id="days" value="30" min="1" max="90"></label>
  <label>ATR_TAKE_K <input type="text" class="inp mid" id="atr_take" value="2,3,4"></label>
  <label>ATR_STOP_K <input type="text" class="inp mid" id="atr_stop" value="1,1.5,2"></label>
  <label>Тариф комиссии <select class="inp" id="tariff">
    <option value="">как в settings.ini</option>
    <option value="TRADER">Трейдер (0.05%/0.04% за сторону)</option>
    <option value="PREMIUM">Премиум (0.04%/0.025% за сторону)</option>
  </select></label>
  <br>
  <label><input type="checkbox" id="dedup_issuer" checked> Без дублей по эмитенту (обычка/префы, фьючерс/базис) —
    топ <input type="number" class="inp" style="width:50px;padding:6px 8px;" id="top_pct" value="70" min="1" max="100">% по востребованности</label>
  <br><br>
  <button class="btn-pill" onclick="runBacktest()">▶ ЗАПУСТИТЬ БЭКТЕСТ</button>
  <span id="status"></span>
  <table class="scen-table" id="results"></table>
</div>

<div class="panel">
  <div class="sec">Портфель (виртуальный счёт)</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:8px;">
    Сделки выбранных выше тикеров (галочки) сводятся в одну хронологию и
    проигрываются по очереди на одном балансе, размер сделки = риск% от
    текущего баланса. Режим "fixed" — take/stop из настроек тикера. Режим
    "ATR" — на каждом тикере для тех же сигналов берётся лучшая по
    expectancy комбинация ATR_TAKE_K/ATR_STOP_K (сетка как в бэктесте выше).
  </div>
  <label>Счёт, ₽ <input type="number" class="inp mid" id="pf_account" value="100000" min="1000"></label>
  <label>Риск на сделку, % <input type="number" class="inp mid" id="pf_risk" value="1" min="0.1" step="0.1"></label>
  <label>Режим
    <select class="inp mid" id="pf_mode">
      <option value="atr" selected>ATR-адаптивный (авто, диапазон ATR_TAKE_K/ATR_STOP_K выше)</option>
      <option value="fixed">fixed (take/stop тикера из settings.ini)</option>
    </select>
  </label>
  <br><br>
  <button class="btn-pill" onclick="runPortfolioSim()">▶ ПРОГНАТЬ ПОРТФЕЛЬ</button>
  <span id="pf_status"></span>
  <div id="pf_summary"></div>
  <div class="sec" style="margin-top:14px;">По месяцам</div>
  <table class="scen-table" id="pf_monthly"></table>
  <div class="sec" style="margin-top:14px;">По тикерам</div>
  <table class="scen-table" id="pf_ticker"></table>
  <div class="sec" style="margin-top:14px;">Отдельные сделки</div>
  <table class="scen-table" id="pf_trades"></table>
</div>

<div class="panel">
  <div class="sec">Совет по багам</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:8px;">
    Лог пишется в файл <b style="color:var(--txt2)">dashboard.log</b> (рядом с dashboard.py) —
    открой его текстовым редактором и скопируй нужный кусок сюда.
  </div>
  <textarea id="bugtext" placeholder="Вставь traceback или лог..."></textarea><br><br>
  <button class="btn-pill" onclick="askCouncil()">СПРОСИТЬ СОВЕТ</button>
  <div id="council_answer"></div>
</div>

<div class="panel">
  <div class="sec">Управление ботом (live)</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:8px;">
    Бот перечитывает эти настройки сам, без перезапуска (раз в свечу).
    Take/Stop-оверрайды действуют только на НОВЫЕ сигналы — открытые позиции не трогаются.
  </div>
  <label>Глобальный режим
    <select class="inp" id="ov_global_mode">
      <option value="auto">как в settings.ini у каждого тикера</option>
      <option value="sandbox">форс-песочница для всех (паника)</option>
      <option value="live">форс-боевой для всех (где не запрещено по тикеру)</option>
    </select>
  </label>
  <label>Код подтверждения (нужен только чтобы включить «боевой»)
    <input type="password" class="inp mid" id="ov_password" placeholder="код из settings.ini">
  </label>
  <br><br>
  <label><input type="checkbox" id="ov_adaptive_exit"> Адаптивный выход (трейлинг-стоп + безубыток после 1R + giveback-защита пика)
    (статичный take_profit сигнала игнорируется, выходим по risk.check_exit; приоритетнее частичной фиксации ниже)
  </label>
  <br><br>
  <label><input type="checkbox" id="ov_partial_tp"> Частичная фиксация на первом тейке
    (половина закрывается на тейке, остаток держится с защитой 1/3 пройденного
    расстояния вход→тейк; не работает вместе с адаптивным выходом)
  </label>
  <br><br>
  <table class="scen-table">
    <thead><tr>
      <th>Тикер</th><th>Торгуется</th><th>Режим (signal_only)</th>
      <th>LONG Take</th><th>LONG Stop</th><th>SHORT Take</th><th>SHORT Stop</th>
    </tr></thead>
    <tbody id="ov_table"></tbody>
  </table>
  <br>
  <button class="btn-pill" onclick="loadOverrides()">⟳ ЗАГРУЗИТЬ ТЕКУЩИЕ</button>
  <button class="btn-pill" onclick="saveOverrides()">💾 СОХРАНИТЬ</button>
  <span id="ov_status"></span>
</div>

<div class="panel">
  <h3>Авто-подобранные ATR_TAKE_K/ATR_STOP_K</h3>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:8px;">
    Считает сам бот раз в день (OICompositeStrategy.__recalc_auto_atr) для тикеров
    без явных ATR_TAKE_K/ATR_STOP_K в settings.ini — sweep по истории, лучшая пара
    по expectancy_pct. Здесь только последний посчитанный снэпшок из data/archive.json.
  </div>
  <table class="scen-table">
    <thead><tr><th>Тикер</th><th>Дата расчёта</th><th>ATR_TAKE_K</th><th>ATR_STOP_K</th></tr></thead>
    <tbody id="auto_atr_table"></tbody>
  </table>
  <br>
  <button class="btn-pill" onclick="loadAutoAtr()">⟳ ОБНОВИТЬ</button>
</div>

<script>
document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => c.classList.toggle('active')));

function modelStatsToHtml(modelStats) {{
  if (!modelStats) return '';
  const parts = [];
  for (const name of ['M1_CLUSTER', 'M2_CLUSTER', 'M3_CLUSTER']) {{
    const s = modelStats[name];
    if (!s) continue;
    const agreePct = s.agree_win_rate !== null && s.agree_win_rate !== undefined
      ? (s.agree_win_rate * 100).toFixed(0) + '%' : '—';
    const dur = s.agree_avg_duration_min !== null && s.agree_avg_duration_min !== undefined
      ? `, ${{s.agree_avg_duration_min.toFixed(0)}}мин` : '';
    parts.push(`${{name.replace('_CLUSTER', '')}}: ${{agreePct}} (n=${{s.agree_n}}${{dur}})`);
  }}
  return parts.join(' / ');
}}

function whatIfToHtml(whatIf) {{
  if (!whatIf) return '';
  const labels = {{m1_cluster_only: 'M1 один', m2_cluster_only: 'M2 один', m3_cluster_only: 'M3 один',
                  all_three_agree: 'все 3 согласны', two_of_three_agree: '2 из 3 согласны'}};
  const parts = [];
  for (const key of ['M1_CLUSTER_ONLY', 'M2_CLUSTER_ONLY', 'M3_CLUSTER_ONLY', 'ALL_THREE_AGREE', 'TWO_OF_THREE_AGREE']) {{
    const s = whatIf[key];
    if (!s || s.n_trades === 0) continue;
    parts.push(`${{labels[key.toLowerCase()]}}: ${{s.pnl_rub.toFixed(0)}}₽ (n=${{s.n_trades}})`);
  }}
  return parts.join(' / ');
}}

function rowsToHtml(rows) {{
  let html = '';
  for (const r of rows) {{
    if (r.error !== undefined && r.n_trades === undefined) {{
      html += `<tr><td><span class="sdot err"></span>${{r.ticker}}</td><td colspan="6" class="err">${{r.mode}}: ${{r.error || ''}}</td></tr>`;
      if (r.advice && r.advice.used_ai) {{
        html += `<tr><td></td><td colspan="6"><div class="advice">
          <b>Диагноз:</b> ${{r.advice.diagnosis}}<br>
          <b>Вероятная причина:</b> ${{r.advice.likely_cause}}<br>
          <b>Предлагаемая правка:</b> ${{r.advice.suggested_fix}}</div></td></tr>`;
      }} else if (r.traceback) {{
        html += `<tr><td></td><td colspan="6"><div class="advice">${{r.traceback}}</div></td></tr>`;
      }}
      continue;
    }}
    const winPct = r.win_rate !== undefined ? (r.win_rate * 100).toFixed(1) + '%' : '';
    const exp = r.expectancy_pct !== undefined ? (r.expectancy_pct * 100).toFixed(2) + '%' : '';
    const avgR = r.avg_r !== undefined ? r.avg_r.toFixed(2) : '';
    const models = modelStatsToHtml(r.model_stats);
    html += `<tr><td><span class="sdot ok"></span>${{r.ticker}}</td><td>${{r.mode}}</td><td>${{r.n_trades ?? ''}}</td><td>${{winPct}}</td><td>${{avgR}}</td><td>${{exp}}</td><td style="font-size:10px;color:var(--txt3);">${{models}}</td></tr>`;
  }}
  return html;
}}

async function applyDedup(tickersIn) {{
  const dedup = document.getElementById('dedup_issuer').checked;
  const topPct = parseFloat(document.getElementById('top_pct').value);
  const resp = await fetch('/api/filter_tickers', {{
    method: 'POST', headers: {{'Content-Type': 'application/json'}},
    body: JSON.stringify({{tickers: tickersIn, dedup: dedup, top_pct: topPct}})
  }});
  return await resp.json();
}}

function droppedToHtml(dropped) {{
  let html = '';
  for (const d of dropped) {{
    html += `<tr><td>${{d.ticker}}</td><td colspan="5" style="color:var(--txt3);">пропущен — ${{d.reason}}</td></tr>`;
  }}
  return html;
}}

async function runBacktest() {{
  const allTickers = Array.from(document.querySelectorAll('.chip.active')).map(c => c.dataset.ticker);
  if (allTickers.length === 0) {{ alert('Выбери хотя бы один тикер'); return; }}
  const table = document.getElementById('results');
  table.innerHTML = '<tr><th>Тикер</th><th>Режим</th><th>Сделок</th><th>Win%</th><th>avg R</th><th>Exp%</th><th>M1/M2/M3 win% (когда согласны)</th></tr>';
  const days = parseInt(document.getElementById('days').value, 10);
  const atrTake = document.getElementById('atr_take').value;
  const atrStop = document.getElementById('atr_stop').value;

  const filtered = await applyDedup(allTickers);
  const tickers = filtered.kept;
  table.innerHTML += droppedToHtml(filtered.dropped);

  document.getElementById('status').textContent =
    `Считаю ${{tickers.length}} тикер(ов) параллельно (до {backtest_workers} одновременно)...`;
  try {{
    const resp = await fetch('/api/backtest', {{
      method: 'POST', headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{tickers: tickers, days: days, atr_take: atrTake, atr_stop: atrStop,
                              tariff: document.getElementById('tariff').value}})
    }});
    const data = await resp.json();
    table.innerHTML += rowsToHtml(data.rows);
  }} catch (e) {{
    table.innerHTML += `<tr><td colspan="6" class="err">сетевая ошибка: ${{e}}</td></tr>`;
  }}
  document.getElementById('status').textContent = `Готово: ${{tickers.length}} тикер(ов)`;
}}

async function importOiFile(ev) {{
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {{
    let data;
    try {{ data = JSON.parse(e.target.result); }} catch (ex) {{
      document.getElementById('oi_status').textContent = 'Ошибка: не JSON';
      return;
    }}
    const tickers = data.tickers || [];
    const resp = await fetch('/api/import_oi', {{
      method: 'POST', headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{tickers: tickers, signalLog: data.signalLog || []}})
    }});
    const result = await resp.json();
    document.getElementById('oi_status').textContent = `✓ импортировано ${{result.imported}} тикеров — перезагрузи страницу`;
  }};
  reader.readAsText(file);
}}

async function fetchMegaAlerts() {{
  document.getElementById('oi_status').textContent = 'тяну аномалии MOEX...';
  try {{
    const resp = await fetch('/api/mega_alerts', {{method: 'POST'}});
    const result = await resp.json();
    document.getElementById('oi_status').textContent =
      `✓ добавлено ${{result.added.length}}, отсеяно дублей ${{result.dropped.length}}, не нашли FIGI ${{result.unresolved.length}} — перезагрузи страницу`;
  }} catch (ex) {{
    document.getElementById('oi_status').textContent = 'сетевая ошибка: ' + ex;
  }}
}}

function pfRowsToHtml(trades) {{
  let html = '';
  for (const t of trades) {{
    html += `<tr><td>${{t.entry_time}}</td><td>${{t.ticker}}${{t.atr_k ? ' (' + t.atr_k + ')' : ''}}</td><td>${{t.direction}}</td><td>${{(t.net_pct*100).toFixed(2)}}%</td><td>${{t.r_multiple}}</td><td>${{t.pnl_rub}}</td><td>${{t.equity_after}}</td><td style="font-size:10px;color:var(--txt3);">M1:${{t.m1}} M2:${{t.m2}} M3:${{t.m3}}</td></tr>`;
  }}
  return html;
}}

async function runPortfolioSim() {{
  const allTickers = Array.from(document.querySelectorAll('.chip.active')).map(c => c.dataset.ticker);
  if (allTickers.length === 0) {{ alert('Выбери хотя бы один тикер'); return; }}
  document.getElementById('pf_status').textContent = 'Считаю...';
  const filtered = await applyDedup(allTickers);
  const tickers = filtered.kept;
  const body = {{
    tickers: tickers,
    days: parseInt(document.getElementById('days').value, 10),
    account: parseFloat(document.getElementById('pf_account').value),
    risk_pct: parseFloat(document.getElementById('pf_risk').value),
    tariff: document.getElementById('tariff').value,
    mode: document.getElementById('pf_mode').value,
    atr_take: document.getElementById('atr_take').value,
    atr_stop: document.getElementById('atr_stop').value,
  }};
  const resp = await fetch('/api/portfolio_sim', {{method: 'POST', headers: {{'Content-Type': 'application/json'}}, body: JSON.stringify(body)}});
  const data = await resp.json();
  document.getElementById('pf_status').textContent = '';

  const s = data.summary;
  const sign = s.pnl_rub >= 0 ? 'var(--pos)' : 'var(--neg)';
  const dedupNote = filtered.dropped.length
    ? `<div style="color:var(--txt3);font-size:10px;margin-top:4px;">Без дублей по эмитенту: пропущено ${{filtered.dropped.length}} (${{filtered.dropped.map(d => d.ticker).join(', ')}})</div>`
    : '';
  document.getElementById('pf_summary').innerHTML =
    `<div class="advice">Старт: ${{s.account_start}} ₽ &nbsp;→&nbsp; Итог: ${{s.equity_end}} ₽ &nbsp;
     (<span style="color:${{sign}}">${{s.pnl_rub >= 0 ? '+' : ''}}${{s.pnl_rub}} ₽</span>) &nbsp;|&nbsp;
     Сделок: ${{s.n_trades}} &nbsp;|&nbsp; Макс. просадка: ${{s.max_drawdown_rub}} ₽</div>${{dedupNote}}
     <div class="advice" style="margin-top:6px;">М1/М2/М3 — win% сделок, где модель была согласна с направлением: ${{modelStatsToHtml(data.model_stats)}}</div>
     <div class="advice" style="margin-top:6px;">Если бы торговали только по модели (без композита): ${{whatIfToHtml(data.what_if)}}</div>`;

  let mh = '<tr><th>Месяц</th><th>Сделок</th><th>Прибыль ₽</th><th>Счёт на конец</th></tr>';
  for (const m of data.monthly) {{
    mh += `<tr><td>${{m.month}}</td><td>${{m.n_trades}}</td><td>${{m.pnl_rub}}</td><td>${{m.equity_end}}</td></tr>`;
  }}
  document.getElementById('pf_monthly').innerHTML = mh;

  let th = '<tr><th>Тикер</th><th>Сделок</th><th>Win%</th><th>Прибыль ₽</th></tr>';
  for (const r of data.per_ticker) {{
    th += `<tr><td>${{r.ticker}}</td><td>${{r.n_trades}}</td><td>${{(r.win_rate*100).toFixed(1)}}%</td><td>${{r.pnl_rub}}</td></tr>`;
  }}
  document.getElementById('pf_ticker').innerHTML = th;

  let trh = '<tr><th>Время входа</th><th>Тикер</th><th>Напр.</th><th>Net%</th><th>R</th><th>P&L ₽</th><th>Счёт после</th><th>M1/M2/M3</th></tr>';
  trh += pfRowsToHtml(data.trades);
  for (const e of (data.errors || [])) {{
    trh += `<tr><td colspan="8" class="err">${{e.ticker}}: ${{e.error}}</td></tr>`;
  }}
  document.getElementById('pf_trades').innerHTML = trh;
}}

function ovRowHtml(ticker, t) {{
  t = t || {{}};
  const en = t.enabled !== false;
  const so = t.signal_only === true ? 'sandbox' : (t.signal_only === false ? 'live' : 'auto');
  return `<tr data-ticker="${{ticker}}">
    <td>${{ticker}}</td>
    <td><input type="checkbox" class="ov_enabled" ${{en ? 'checked' : ''}}> торгуется</td>
    <td><select class="inp ov_signal_only">
      <option value="auto" ${{so === 'auto' ? 'selected' : ''}}>как в settings.ini</option>
      <option value="sandbox" ${{so === 'sandbox' ? 'selected' : ''}}>песочница</option>
      <option value="live" ${{so === 'live' ? 'selected' : ''}}>боевой</option>
    </select></td>
    <td><input type="text" class="inp ov_long_take" style="width:70px" value="${{t.long_take ?? ''}}" placeholder="—"></td>
    <td><input type="text" class="inp ov_long_stop" style="width:70px" value="${{t.long_stop ?? ''}}" placeholder="—"></td>
    <td><input type="text" class="inp ov_short_take" style="width:70px" value="${{t.short_take ?? ''}}" placeholder="—"></td>
    <td><input type="text" class="inp ov_short_stop" style="width:70px" value="${{t.short_stop ?? ''}}" placeholder="—"></td>
  </tr>`;
}}

async function loadOverrides() {{
  const resp = await fetch('/api/overrides');
  const data = await resp.json();
  document.getElementById('ov_global_mode').value =
    data.global_signal_only === true ? 'sandbox' : (data.global_signal_only === false ? 'live' : 'auto');
  document.getElementById('ov_partial_tp').checked = data.partial_tp_enabled === true;
  document.getElementById('ov_adaptive_exit').checked = data.adaptive_exit_enabled === true;
  const tbody = document.getElementById('ov_table');
  tbody.innerHTML = data.tickers_all.map(t => ovRowHtml(t, data.tickers[t])).join('');
  document.getElementById('ov_status').textContent = 'загружено';
}}

async function saveOverrides() {{
  const globalMode = document.getElementById('ov_global_mode').value;
  const global_signal_only = globalMode === 'sandbox' ? true : (globalMode === 'live' ? false : null);
  const partial_tp_enabled = document.getElementById('ov_partial_tp').checked;
  const adaptive_exit_enabled = document.getElementById('ov_adaptive_exit').checked;
  const tickers = {{}};
  document.querySelectorAll('#ov_table tr').forEach(tr => {{
    const ticker = tr.dataset.ticker;
    const soVal = tr.querySelector('.ov_signal_only').value;
    const num = (sel) => {{
      const v = tr.querySelector(sel).value.trim();
      return v === '' ? null : v;
    }};
    tickers[ticker] = {{
      enabled: tr.querySelector('.ov_enabled').checked,
      signal_only: soVal === 'sandbox' ? true : (soVal === 'live' ? false : null),
      long_take: num('.ov_long_take'), long_stop: num('.ov_long_stop'),
      short_take: num('.ov_short_take'), short_stop: num('.ov_short_stop'),
    }};
  }});
  const resp = await fetch('/api/overrides', {{
    method: 'POST',
    headers: {{'Content-Type': 'application/json'}},
    body: JSON.stringify({{
      global_signal_only, partial_tp_enabled, adaptive_exit_enabled, tickers,
      password: document.getElementById('ov_password').value,
    }}),
  }});
  const result = await resp.json();
  document.getElementById('ov_status').textContent = result.error ? ('ОШИБКА: ' + result.error) : 'сохранено';
}}

loadOverrides();

async function loadAutoAtr() {{
  const resp = await fetch('/api/auto_atr');
  const data = await resp.json();
  const tbody = document.getElementById('auto_atr_table');
  tbody.innerHTML = data.rows.map(r => `<tr>
    <td>${{r.ticker}}</td>
    <td>${{r.date}}</td>
    <td>${{r.auto_atr_take_k}}</td>
    <td>${{r.auto_atr_stop_k}}</td>
  </tr>`).join('') || '<tr><td colspan="4">нет данных</td></tr>';
}}
loadAutoAtr();

async function askCouncil() {{
  const text = document.getElementById('bugtext').value;
  if (!text.trim()) return;
  const div = document.getElementById('council_answer');
  div.innerHTML = '<i>Спрашиваю...</i>';
  const resp = await fetch('/api/council', {{method: 'POST', headers: {{'Content-Type': 'application/json'}}, body: JSON.stringify({{text: text}})}});
  const data = await resp.json();
  if (data.used_ai) {{
    div.innerHTML = `<div class="advice"><b>Диагноз:</b> ${{data.diagnosis}}<br><b>Вероятная причина:</b> ${{data.likely_cause}}<br><b>Предлагаемая правка:</b> ${{data.suggested_fix}}</div>`;
  }} else {{
    div.innerHTML = '<div class="advice">AI недоступен (нет CEREBRAS_API_KEY или ошибка вызова) — добавь ключ в settings.ini [NEWS].</div>';
  }}
}}
</script>
</body>
</html>
"""


def get_overrides_payload() -> dict:
    """Текущий data/bot_overrides.json + полный список тикеров (settings.ini + OI) для таблицы."""
    data = load_overrides()
    tickers_all = sorted(set(_strategy_settings_by_ticker().keys()) | set(load_oi_tickers().keys()))
    return {
        "global_signal_only": data.get("global_signal_only"),
        "partial_tp_enabled": data.get("partial_tp_enabled"),
        "adaptive_exit_enabled": data.get("adaptive_exit_enabled"),
        "tickers": data.get("tickers", {}),
        "tickers_all": tickers_all,
    }


def save_overrides_payload(payload: dict) -> dict | None:
    """
    Возвращает None при успехе, {"error": ...} если запрошен переход в боевой
    режим (глобально или для конкретного тикера) без верного пароля
    из settings.ini [DASHBOARD_CONTROL] PASSWORD.
    """
    global_signal_only = payload.get("global_signal_only")
    partial_tp_enabled = payload.get("partial_tp_enabled")
    adaptive_exit_enabled = payload.get("adaptive_exit_enabled")
    tickers_in = payload.get("tickers", {})

    wants_live = global_signal_only is False or any(
        t.get("signal_only") is False for t in tickers_in.values()
    )
    if wants_live:
        expected = _config.dashboard_password
        if not expected or not hmac.compare_digest(payload.get("password") or "", expected):
            return {"error": "неверный или не настроен код подтверждения (settings.ini [DASHBOARD_CONTROL] PASSWORD)"}

    tickers_out = {}
    for ticker, t in tickers_in.items():
        entry = {"enabled": bool(t.get("enabled", True))}
        if t.get("signal_only") is not None:
            entry["signal_only"] = bool(t["signal_only"])
        else:
            entry["signal_only"] = None
        for field in ("long_take", "long_stop", "short_take", "short_stop"):
            v = t.get(field)
            entry[field] = str(v) if v not in (None, "") else None
        tickers_out[ticker.upper()] = entry

    save_overrides({
        "global_signal_only": global_signal_only,
        "partial_tp_enabled": partial_tp_enabled,
        "adaptive_exit_enabled": adaptive_exit_enabled,
        "tickers": tickers_out,
    })
    return None


def _render_page() -> bytes:
    oi_tickers = load_oi_tickers()
    tickers = sorted(_strategy_settings_by_ticker().keys())
    checkboxes = "".join(
        f'<div class="chip active" data-ticker="{t}" title="{"импортирован из OI" if t in oi_tickers else "settings.ini"}">{t}{" •" if t in oi_tickers else ""}</div>'
        for t in tickers
    )
    return PAGE_HTML.format(ticker_checkboxes=checkboxes, backtest_workers=BACKTEST_WORKERS).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, payload: dict, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/":
            body = _render_page()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/api/overrides":
            self._send_json(get_overrides_payload())
        elif self.path == "/api/auto_atr":
            self._send_json({"rows": get_auto_atr_snapshot()})
        else:
            self.send_error(404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json({"error": "bad json"}, 400)
            return

        if self.path == "/api/backtest_one":
            ticker = payload.get("ticker", "")
            days = int(payload.get("days", 30))
            atr_take_ks = [float(x) for x in str(payload.get("atr_take", "2,3,4")).split(",") if x.strip()]
            atr_stop_ks = [float(x) for x in str(payload.get("atr_stop", "1,1.5,2")).split(",") if x.strip()]
            tariff = payload.get("tariff") or None
            rows = run_backtest_one(ticker, days, atr_take_ks, atr_stop_ks, tariff=tariff)
            self._send_json({"rows": rows})
        elif self.path == "/api/backtest":
            tickers = payload.get("tickers", [])
            days = int(payload.get("days", 30))
            atr_take_ks = [float(x) for x in str(payload.get("atr_take", "2,3,4")).split(",") if x.strip()]
            atr_stop_ks = [float(x) for x in str(payload.get("atr_stop", "1,1.5,2")).split(",") if x.strip()]
            tariff = payload.get("tariff") or None
            rows = run_backtest(tickers, days, atr_take_ks, atr_stop_ks, tariff=tariff)
            self._send_json({"rows": rows})
        elif self.path == "/api/portfolio_sim":
            tickers = payload.get("tickers", [])
            days = int(payload.get("days", 30))
            account = float(payload.get("account", 100000))
            risk_pct = float(payload.get("risk_pct", 1))
            tariff = payload.get("tariff") or None
            mode = payload.get("mode") or "atr"
            atr_take_ks = [float(x) for x in str(payload.get("atr_take", "2,3,4")).split(",") if x.strip()]
            atr_stop_ks = [float(x) for x in str(payload.get("atr_stop", "1,1.5,2")).split(",") if x.strip()]
            result = run_portfolio_sim(tickers, days, account, risk_pct, tariff=tariff,
                                        mode=mode, atr_take_ks=atr_take_ks, atr_stop_ks=atr_stop_ks)
            self._send_json(result)
        elif self.path == "/api/import_oi":
            oi_tickers = payload.get("tickers", [])
            signal_log = payload.get("signalLog", [])
            n = merge_oi_tickers(oi_tickers, signal_log)
            self._send_json({"imported": n, "tickers": sorted(_strategy_settings_by_ticker().keys())})
        elif self.path == "/api/mega_alerts":
            self._send_json(fetch_mega_alert_tickers())
        elif self.path == "/api/filter_tickers":
            tickers = payload.get("tickers", [])
            dedup = bool(payload.get("dedup", False))
            top_pct = float(payload.get("top_pct", 70)) / 100.0
            self._send_json(filter_active_tickers(tickers, dedup, top_pct))
        elif self.path == "/api/council":
            text = payload.get("text", "")
            advice = bug_council.analyze_bug(text, context="ручной запрос через дашборд")
            self._send_json(advice)
        elif self.path == "/api/overrides":
            error = save_overrides_payload(payload)
            self._send_json(error if error else {"ok": True})
        else:
            self.send_error(404)

    def log_message(self, fmt, *args):
        logger.info("%s - %s", self.address_string(), fmt % args)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Дашборд: http://127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
