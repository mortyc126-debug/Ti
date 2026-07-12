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

import ssl_setup  # noqa: F401 — ставит certifi CA до любых SSL-контекстов (urllib/HTTPS)

import datetime
import multiprocessing
import dataclasses
import statistics
import threading
import time
import traceback
import csv
import io
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional

from tinkoff.invest.exceptions import RequestError

import bug_council
from atomic_json import atomic_write_json
from archive import ArchiveStore
from calibration import PercentileCalibrator
from candle_archive import get_candles_cached, get_candles_cached_futures_chain
from configuration.configuration import ProgramConfiguration
from configuration.settings import StrategySettings
from db_api_client import DbApiClient
from market_time import today_msk
from history import BacktestHistoryStore, HistoryStore
from invest_api.services.instruments_service import InstrumentService
from invest_api.services.market_data_service import MarketDataService
from mega_alerts import MegaAlertsService
from runtime_overrides import load_overrides, save_overrides
import bot_supervisor
import ticker_universe
from trade_system.issuer_filter import issuer_key, select_top_tickers
from trade_system.strategies.oi_composite_strategy import (
    AUTO_ATR_MIN_TRADES, AUTO_ATR_SCALE_EXPS, AUTO_ATR_STOP_KS, AUTO_ATR_TAKE_KS,
    ATR_EVAL_LOOKBACK, ALL_METHOD_NAMES,
)
from trade_system.strategies.strategy_factory import StrategyFactory

CONFIG_FILE = "settings.ini"
LOG_FILE = "dashboard.log"
OI_TICKERS_FILE = "oi_tickers.json"

# Полные трейды последнего прогона (ticker → list[trade_dict]).
# Хранятся в памяти для CSV-экспорта (/api/export_trades_csv).
_last_full_trades: dict[str, list[dict]] = {}
_last_full_trades_lock = threading.Lock()

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


def _wire_history_returning(strategy) -> BacktestHistoryStore:
    """Как _wire_history, но возвращает store чтобы после прогона можно было
    забрать накопленные сделки и сохранить их в реальный HistoryStore."""
    store = BacktestHistoryStore()
    if hasattr(strategy, "set_history"):
        strategy.set_history(store, PercentileCalibrator())
    return store


def _get_backtest_candles(ticker: str, settings, days: int, offset_days: int = 0):
    """Свечи для бэктеста. Для фьючерсов пробуем два интервала:
    1) 5-мин — D1 хранит их глубоко, нужны для исторических периодов.
    2) 1-мин fallback — для экзотики, у которой нет 5-мин в D1/Tinkoff,
       но есть свежие 1-мин данные (работает только для недавних периодов).
    Возвращаем то, что длиннее."""
    if getattr(settings, "is_future", False):
        candles_5m = get_candles_cached_futures_chain(
            ticker, settings.figi, days, _market_data, _db, _instrument_service,
            candle_interval_min=5, offset_days=offset_days,
        )
        if candles_5m:
            return candles_5m
        # fallback: пробуем нативный интервал (обычно 1-мин) — только для текущих периодов
        if settings.candle_interval_min != 5:
            candles_native = get_candles_cached_futures_chain(
                ticker, settings.figi, days, _market_data, _db, _instrument_service,
                candle_interval_min=settings.candle_interval_min, offset_days=offset_days,
            )
            if candles_native:
                return candles_native
        return candles_5m  # пустой список
    return get_candles_cached(
        ticker, settings.figi, days, _market_data, _db,
        candle_interval_min=settings.candle_interval_min, offset_days=offset_days,
    )


def _index_context_provider_for_backtest(days: int, offset_days: int = 0):
    """IndexContextBacktestProvider на дневках фьюча IMOEX (склейка контрактов
    через futures_chain). Дневки агрегируются из 5-мин кэша; +75 дней запаса —
    на LEVEL_LOOKBACK/MIN_DAILY_BARS до начала окна бэктеста. None, если
    контракта IMOEX нет в кэше фьючерсов или нет свечей — метод просто молчит."""
    try:
        from index_context import IndexContextBacktestProvider, daily_from_intraday
        contracts, _age = _futures_cache_from_disk()
        info = (contracts or {}).get("IMOEX")
        if not info or not info.get("figi"):
            return None
        candles = get_candles_cached_futures_chain(
            info["ticker"], info["figi"], days + 75, _market_data, _db,
            _instrument_service, candle_interval_min=5, offset_days=offset_days)
        if not candles:
            return None
        prov = IndexContextBacktestProvider(daily_from_intraday(candles))
        return prov if prov.has_data() else None
    except Exception as e:
        logger.warning(f"INDEX_CONTEXT (backtest): не построен — {e}")
        return None


def _backtest_strategy_settings(settings) -> "StrategySettings":
    """Для фьючерсов в историческом бэктесте мы всегда грузим 5-мин свечи
    (Tinkoff отдаёт 1-мин только за последние ~7 дней, D1 хранит только 5-мин).
    Если оставить candle_interval_min=1, стратегия строит окно 150 баров вместо 30
    и включает MTF-агрегацию 5→25-мин (бессмысленную на реальных 5-мин данных),
    что обрушивает composite ниже порога на все 150 дней."""
    if getattr(settings, "is_future", False) and getattr(settings, "candle_interval_min", 5) != 5:
        return dataclasses.replace(settings, candle_interval_min=5)
    return settings


def _save_backtest_history_one(
        ticker: str, days: int, offset_days: int = 0, progress: dict | None = None,
) -> tuple[str, dict | None, int, str | None]:
    """Считает накопленную историю одного тикера (для save_backtest_history).
    Выделено в отдельную функцию, чтобы гонять тикеры параллельно по
    процессам — тот же CPU-bound скан, что и в run_backtest_one."""
    if progress is None:
        progress = _get_progress_proxy()
    by_ticker = _all_settings_by_ticker()
    settings = by_ticker.get(ticker)
    if settings is None:
        _set_progress(progress, ticker, "ошибка")
        return ticker, None, 0, f"{ticker}: нет в settings"
    try:
        strategy = StrategyFactory.new_factory(settings.name, _backtest_strategy_settings(settings))
        bt_store = _wire_history_returning(strategy)
        _set_progress(progress, ticker, "загрузка свечей")
        candles = _get_backtest_candles(ticker, settings, days, offset_days)
        if not candles:
            _set_progress(progress, ticker, "нет истории")
            return ticker, None, 0, f"{ticker}: нет свечей"
        _set_progress(progress, ticker, f"скан сигналов ({len(candles)} свечей)")
        from oi_layers import OiBacktestProvider
        oi_prov = OiBacktestProvider.load()
        oi_hook = None
        if oi_prov.has_data(ticker):
            strategy.set_inst_oi_provider(oi_prov.inst_oi_score)
            strategy.set_retail_contra_provider(oi_prov.retail_contra_score)
            strategy.set_delta_quadrant_provider(oi_prov.delta_quadrant_score)
            strategy.set_oi_absorption_provider(oi_prov.absorption_score)
            strategy.set_squeeze_provider(oi_prov.squeeze_score)
            strategy.set_oi_regime_provider(oi_prov.oi_instability_score)
            oi_hook = oi_prov.set_date
        idx_prov = _index_context_provider_for_backtest(days, offset_days)
        if idx_prov is not None and hasattr(strategy, "set_index_context_provider"):
            strategy.set_index_context_provider(idx_prov.score)
            if oi_hook is None:
                oi_hook = idx_prov.set_date
            else:
                _oi_hook0 = oi_hook
                def oi_hook(d, _h0=_oi_hook0, _p=idx_prov):
                    _h0(d)
                    _p.set_date(d)
        strategy.backtest_barriers(candles, oi_date_hook=oi_hook)
        hist = bt_store._data.get(ticker, {})
        n_trades = sum(len(day.get("trades", [])) for day in hist.values())
        _set_progress(progress, ticker, "готово")
        return ticker, hist, n_trades, None
    except Exception as ex:
        _set_progress(progress, ticker, "ошибка")
        return ticker, None, 0, f"{ticker}: {ex}"


def _persist_history_dicts(hist_by_ticker: dict[str, dict]) -> tuple[int, int]:
    """Сливает уже посчитанные {ticker: hist} в реальный data/history.json.
    Общий код для save_backtest_history и автосохранения по итогам
    /api/backtest_stream — пишет на диск то, что уже есть в памяти, без
    отдельного HTTP-запроса (который может упереться в перегруженный сразу
    после прогона сервер, см. save_backtest_history)."""
    real_store = HistoryStore()
    total_days = 0
    total_trades = 0
    for ticker, hist in hist_by_ticker.items():
        if not hist:
            continue
        tmp = BacktestHistoryStore()
        tmp._data[ticker] = hist
        total_days += tmp.merge_into(real_store)
        total_trades += sum(len(day.get("trades", [])) for day in hist.values())
    return total_days, total_trades


def save_backtest_history(tickers: list[str], days: int, offset_days: int = 0) -> dict:
    """Прогоняет бэктест по тикерам и сохраняет накопленные сделки/скоры
    в data/history.json. Используется для начальной калибровки lasso без
    ожидания живых сделок. Тикеры — независимые CPU-bound сканы, поэтому
    при >1 тикере гоняем параллельно по процессам (как run_backtest).
    offset_days — см. get_candles_cached: сдвигает период в прошлое, чтобы
    добрать более старый кусок истории без пересчёта уже посчитанного."""
    real_store = HistoryStore()
    total_days = 0
    total_trades = 0
    errors: list[str] = []

    progress = _get_progress_proxy()
    for ticker in tickers:
        _set_progress(progress, ticker, "в очереди")

    if len(tickers) <= 1:
        results = [_save_backtest_history_one(t, days, offset_days, progress=progress) for t in tickers]
    else:
        results = []
        pool = ProcessPoolExecutor(max_workers=min(BACKTEST_WORKERS, len(tickers)))
        _register_pool(pool)
        try:
            futures = {
                pool.submit(_save_backtest_history_one, t, days, offset_days, progress): t
                for t in tickers
            }
            for fut in as_completed(futures):
                ticker = futures[fut]
                try:
                    results.append(fut.result())
                except Exception as ex:
                    results.append((ticker, None, 0, f"{ticker}: {ex}"))
        finally:
            _unregister_pool(pool)
            pool.shutdown(wait=True, cancel_futures=True)

    for ticker, hist, n_trades, err in results:
        if err:
            errors.append(err)
            continue
        if hist is None:
            continue
        tmp = BacktestHistoryStore()
        tmp._data[ticker] = hist
        merged = tmp.merge_into(real_store)
        total_days += merged
        total_trades += n_trades

    return {"saved_days": total_days, "trades": total_trades, "errors": errors}


def save_cached_backtest_history(tickers: list[str], days: int, offset_days: int = 0) -> dict:
    """То же самое, что save_backtest_history(), но без повторного прогона:
    использует данные, уже посчитанные последним runBacktest() в дашборде
    (_last_backtest_history_data) — то, что видно в таблице результатов.
    Тикеры без кэша (бэктест по ним ещё не запускали в этой сессии сервера)
    прогоняются по старой схеме как fallback, за тот же период (days/offset_days).
    Кэш в _last_backtest_history_data ключуется только по тикеру, без периода —
    если между прогонами поменять offset_days для того же тикера, в кэше
    останутся данные ИЗ ПОСЛЕДНЕГО прогона; сохранять нужно сразу после
    каждого прогона, не накапливая периоды вперемешку."""
    real_store = HistoryStore()
    total_days = 0
    total_trades = 0
    errors: list[str] = []
    missing: list[str] = []

    for ticker in tickers:
        hist = _last_backtest_history_data.get(ticker)
        # hist is None -> бэктест по тикеру не запускали (нет кэша вообще);
        # hist == {} -> запускали, но не записалось ни дня (слишком мало
        # свечей для скана) — оба случая разные: только первый требует
        # пересчёта, иначе тикеры без сделок гонялись бы заново каждый раз.
        if hist is None:
            missing.append(ticker)
            continue
        if not hist:
            continue
        tmp = BacktestHistoryStore()
        tmp._data[ticker] = hist
        merged = tmp.merge_into(real_store)
        n_trades = sum(len(day.get("trades", [])) for day in hist.values())
        total_days += merged
        total_trades += n_trades

    if missing:
        fallback = save_backtest_history(missing, days, offset_days)
        total_days += fallback["saved_days"]
        total_trades += fallback["trades"]
        errors.extend(fallback["errors"])

    return {"saved_days": total_days, "trades": total_trades, "errors": errors,
            "from_cache": len(tickers) - len(missing), "recomputed": missing}


def run_calibration_pipeline(tickers: list[str], days: int, progress: dict | None = None) -> dict:
    """Шаги 2-4 run_pipeline.py (narrative-пороги + lasso + rule_miner) на
    уже сохранённой data/history.json — без бэктеста (см. save_backtest_history
    для шага 1). Дёргается из дашборда кнопкой "🎯 калибровать", чтобы не лезть
    в консоль каждый раз после "💾 сохранить историю".

    progress — отдельный ключ "_calibration" в общем progress-proxy (не
    per-ticker, как у бэктеста): единица работы тут — (стадия, тикер), а
    тикер проходит ВСЕ 3 стадии последовательно, так что per-ticker
    терминальный статус не передал бы общий ETA по конвейеру."""
    # Импорт внутри функции, не на уровне модуля: calibrate_narrative/
    # lasso_calibration/rule_miner сами импортируют из dashboard
    # (_strategy_settings_by_ticker, _db, _market_data, _wire_history) —
    # импорт на верхнем уровне даёт циклический импорт при старте dashboard.py.
    import calibrate_narrative
    import lasso_calibration
    import rule_miner

    if progress is None:
        progress = _get_progress_proxy()
    total_steps = 3 * len(tickers)
    step = 0

    def _tick(stage: str, ticker: str) -> None:
        nonlocal step
        step += 1
        try:
            progress["_calibration"] = {
                "step": step, "total": total_steps, "stage": stage, "ticker": ticker, "ts": time.time(),
            }
        except Exception:
            pass

    errors: list[str] = []
    by_ticker = _strategy_settings_by_ticker()

    existing_thresh = calibrate_narrative._load_existing()
    n_pairs_before = sum(len(v) for v in existing_thresh.values())
    for ticker in tickers:
        _tick("narrative", ticker)
        try:
            result = calibrate_narrative._calibrate_one(ticker, days)
        except Exception as ex:
            errors.append(f"narrative/{ticker}: {ex}")
            continue
        if result:
            existing_thresh = calibrate_narrative._merge(existing_thresh, result)
    calibrate_narrative._save(existing_thresh)
    narrative_pairs = sum(len(v) for v in existing_thresh.values()) - n_pairs_before

    existing_lasso = lasso_calibration._load_existing()
    lasso_tickers = 0
    for ticker in tickers:
        _tick("lasso", ticker)
        try:
            result = lasso_calibration._calibrate_one(ticker, days, 0.01, 0.8, False)
        except Exception as ex:
            errors.append(f"lasso/{ticker}: {ex}")
            continue
        if result:
            st = by_ticker.get(ticker)
            key = st.figi if st else ticker
            existing_lasso[key] = result
            lasso_tickers += 1
    lasso_calibration._save(existing_lasso)

    existing_rules = rule_miner._load_existing()
    rule_tickers = 0
    for ticker in tickers:
        _tick("rules", ticker)
        try:
            result = rule_miner._mine_one(ticker, days, rule_miner._DEFAULT_MAX_DEPTH)
        except Exception as ex:
            errors.append(f"rule_miner/{ticker}: {ex}")
            continue
        if result:
            existing_rules[ticker] = result
            rule_tickers += 1
    rule_miner._save(existing_rules)

    try:
        progress["_calibration"] = {
            "step": total_steps, "total": total_steps, "stage": "готово", "ticker": "", "ts": time.time(),
        }
    except Exception:
        pass

    return {
        "narrative_pairs": narrative_pairs,
        "lasso_tickers": lasso_tickers,
        "rule_tickers": rule_tickers,
        "errors": errors,
    }


_config = ProgramConfiguration(CONFIG_FILE)
_market_data = MarketDataService(_config.tinkoff_token, _config.tinkoff_app_name)
_instrument_service = InstrumentService(_config.tinkoff_token, _config.tinkoff_app_name)
_mega_alerts = MegaAlertsService()
_db = DbApiClient(_config.mega_alerts_settings.db_api_url, _config.mega_alerts_settings.db_api_key)
_archive = ArchiveStore()

# Скан __compute_composite() на каждом баре (Hawkes-MLE через scipy.optimize)
# — CPU-bound, кэш свечей тут не помогает. Гоняем тикеры параллельно по
# процессам (не по тредам — GIL не отпускается на каждой scipy-итерации).
# Раньше дефолт был 4 "на глаз" — теперь берём число ядер минус один (не
# забирать всю машину под бэктест), но не меньше 4: на машинах с < 6 ядрами
# BLAS уже ограничен одним тредом на процесс (см. выше), так что 1 ядро на
# процесс — это нижняя граница, ниже которой просто меньше параллелизма.
# -1 (а не -2) оставлял системе всего ОДНО свободное ядро на ОС+браузер+сам
# процесс дашборда (главный поток, который отвечает на GET / при обновлении
# страницы) — под нагрузкой это ядро забивается, ответ на простой GET
# запаздывает, и браузер рвёт соединение по таймауту ("обновил страницу —
# ошибка", хотя сам прогон продолжается). -2 оставляет больше запаса.
BACKTEST_WORKERS = int(os.getenv("BACKTEST_WORKERS", max(2, (os.cpu_count() or 4) - 2)))

# CANDLE_REQUEST_DELAY в market_data_service.py был откалиброван на 4
# параллельных воркера (0.5с * 4 ≈ 480 запросов/60с, под лимитом Tinkoff
# 600/60с). С тех пор как дефолт BACKTEST_WORKERS стал cpu_count()-1 (часто
# больше 4), та же задержка на бОльшем числе процессов суммарно превышала
# лимит → RESOURCE_EXHAUSTED при холодном кэше. Масштабируем задержку
# пропорционально реальному числу воркеров, чтобы суммарный темп запросов
# остался ~под тем же потолком независимо от BACKTEST_WORKERS.
import invest_api.services.market_data_service as _market_data_service_module  # noqa: E402
_market_data_service_module.CANDLE_REQUEST_DELAY = max(
    _market_data_service_module.CANDLE_REQUEST_DELAY, 0.5 * BACKTEST_WORKERS / 4
)

# Прогресс по тикерам во время прогона (грузим ли свечи, считаем ли сигналы,
# готово/ошибка) — раньше дашборд не показывал НИЧЕГО, пока не закончатся
# ВСЕ тикеры (run_backtest/run_portfolio_sim возвращали результат только
# после as_completed по всем futures). ProcessPoolExecutor — отдельные
# процессы, обычный dict между ними не шарится, нужен Manager().dict().
#
# Manager() создаём ЛЕНИВО (не на уровне модуля!) — на Windows (spawn, а не
# fork) eager-вызов здесь крашит сам запуск `python dashboard.py`: spawn
# пересобирает __main__ через runpy ещё для старта менеджерского
# подпроцесса, и без `if __name__ == "__main__":` это нарушает
# multiprocessing's "не стартовать новый процесс до конца bootstrap"
# (RuntimeError "before bootstrapping phase"). Прокси-dict передаём явным
# аргументом в воркеры пула — на spawn глобал в дочернем процессе — это
# отдельный объект, обычная ссылка на модульный _progress не шарится.
_progress_manager = None
_progress: dict = {}
_progress_lock = threading.Lock()

# Кэш последнего готового результата /api/backtest и /api/portfolio_sim.
# Без него: если HTTP-соединение оборвётся ПОСЛЕ того как сервер досчитал
# результат, но ДО того как успел его отправить (на Windows такое бывает
# из-за антивируса/файрвола/браузера, рвущих долгий синхронный POST —
# прогресс по тикерам в /api/progress при этом уже дошёл до "готово", а
# таблица результатов так и не появляется) — посчитанные данные просто
# теряются и нужен полный повторный прогон. Фронтенд при сетевой ошибке
# забирает их отсюда вместо повторного счёта.
_last_result: dict[str, dict] = {}

# Дневные скоры/сделки бэктеста с последнего прогона runBacktest(), по тикеру
# (см. run_backtest_one). Без этого "сохранить историю" гоняла отдельный,
# более простой бэктест с нуля заново — те же тикеры считались дважды по
# разной логике, и сохранённые сделки не совпадали с тем, что видно в
# таблице. Теперь сохранение берёт уже посчитанное отсюда.
_last_backtest_history_data: dict[str, dict] = {}


def _get_progress_proxy() -> dict:
    # ThreadingHTTPServer: GET /api/progress (опрос) и POST /api/backtest*
    # выполняются в разных потоках и оба зовут эту функцию — без блокировки
    # check-then-act на "_progress_manager is None" не атомарен, оба потока
    # могут одновременно создать свой Manager(); тогда воркеры пишут в один
    # dict, а /api/progress читает другой (тот, что выставился последним) —
    # прогресс молча "теряется". Lock делает инициализацию однократной.
    global _progress_manager, _progress
    if _progress_manager is None:
        with _progress_lock:
            if _progress_manager is None:
                _progress_manager = multiprocessing.Manager()
                _progress = _progress_manager.dict()
    return _progress


def _set_progress(progress: dict, ticker: str, status: str) -> None:
    try:
        progress[ticker] = {"status": status, "ts": time.time()}
    except Exception:
        # Manager-процесс может быть недоступен на shutdown — прогресс это
        # необязательный UI-сахар, не должен валить сам прогон.
        pass


# Терминальные статусы тикера — дальше с ним уже ничего не происходит.
_DONE_STATUSES = {"готово", "ошибка", "ошибка API", "нет истории", "пропуск", "отменено"}


def _mark_unfinished_cancelled(progress: dict, tickers: list[str]) -> None:
    """После отмены прогона — тикеры, которые так и не дошли до терминального
    статуса (ещё в очереди / считались, пока процесс не убили), помечаем
    явно, иначе их статус навечно зависает на "скан сигналов..."/"в очереди"
    в /api/progress, и непонятно — прогон стоит или просто долго думает."""
    for t in tickers:
        cur = progress.get(t)
        status = cur.get("status") if cur else None
        if status not in _DONE_STATUSES:
            _set_progress(progress, t, "отменено")


# Кнопка "Стоп": ProcessPoolExecutor.shutdown(cancel_futures=True) снимает
# только ещё НЕ запущенные задачи — уже работающие воркер-процессы будут
# молотить до конца, если их не убить явно. _active_pool — текущий
# пул, чтобы /api/cancel мог достать его процессы и terminate() их (доступ
# к приватному _processes — единственный способ остановить уже запущенный
# CPU-bound скан без поддержки отмены внутри самого скана).
_cancel_event = threading.Event()
_active_pool_lock = threading.Lock()
_active_pool: Optional[ProcessPoolExecutor] = None


def _register_pool(pool: ProcessPoolExecutor) -> None:
    global _active_pool
    with _active_pool_lock:
        _active_pool = pool


def _unregister_pool(pool: ProcessPoolExecutor) -> None:
    global _active_pool
    with _active_pool_lock:
        if _active_pool is pool:
            _active_pool = None


def request_cancel() -> bool:
    """Вызывается из /api/cancel. Возвращает True, если был активный прогон."""
    _cancel_event.set()
    with _active_pool_lock:
        pool = _active_pool
    if pool is None:
        return False
    # _processes снимаем ДО shutdown: shutdown(wait=False) запускает
    # process-management-thread, который сам обнуляет pool._processes
    # примерно в то же время — getattr после shutdown иногда ловит None
    # вместо словаря и роняет необработанным AttributeError весь обработчик
    # запроса (кнопка "Стоп" не отрабатывает с первого клика).
    procs = list((getattr(pool, "_processes", None) or {}).values())
    try:
        pool.shutdown(wait=False, cancel_futures=True)
    except Exception:
        pass
    for p in procs:
        try:
            if p.is_alive():
                p.terminate()
        except Exception:
            pass
    return True

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


def get_history_coverage() -> list[dict]:
    """
    Какой период уже покрыт в data/history.json по каждому тикеру —
    чтобы не гадать, на сколько дней двигать offset_days в форме бэктеста.
    Дни сделок/бэктеста пишутся под реальную (для backtest — симулируемую)
    дату как ключ (см. history.py HistoryStore._data), поэтому min/max ключ
    по тикеру = крайние даты, уже посчитанные и сохранённые.
    """
    store = HistoryStore()
    rows = []
    for ticker in store.tickers():
        dates = sorted(store._data.get(ticker, {}).keys())
        if not dates:
            continue
        n_trades = sum(len(store._data[ticker][d].get("trades", [])) for d in dates)
        rows.append({
            "ticker": ticker,
            "from": dates[0],
            "to": dates[-1],
            "days": len(dates),
            "trades": n_trades,
        })
    rows.sort(key=lambda r: r["ticker"])
    return rows


def get_mfe_mae_stats() -> dict:
    """Медианы MFE/MAE/quality по тикерам и общий итог из data/history.json."""
    store = HistoryStore()
    per_ticker = []
    all_mfe, all_mae, all_q = [], [], []

    for ticker in sorted(store.tickers()):
        mfes, maes, qs = [], [], []
        for day_data in store._data.get(ticker, {}).values():
            for t in day_data.get("trades", []):
                mfe = t.get("mfe")
                mae = t.get("mae")
                q   = t.get("quality")
                if mfe is not None and mae is not None:
                    mfes.append(mfe)
                    maes.append(mae)
                    all_mfe.append(mfe)
                    all_mae.append(mae)
                if q is not None:
                    qs.append(q)
                    all_q.append(q)
        if not mfes:
            continue
        med = statistics.median
        per_ticker.append({
            "ticker":   ticker,
            "n":        len(mfes),
            "mfe_med":  round(med(mfes) * 100, 3),
            "mae_med":  round(med(maes) * 100, 3),
            "ratio":    round(med(mfes) / (med(maes) + 1e-8), 2),
            "q_med":    round(med(qs) * 100, 1) if qs else None,
        })

    total = {}
    if all_mfe:
        med = statistics.median
        total = {
            "n":       len(all_mfe),
            "mfe_med": round(med(all_mfe) * 100, 3),
            "mae_med": round(med(all_mae) * 100, 3),
            "ratio":   round(med(all_mfe) / (med(all_mae) + 1e-8), 2),
            "q_med":   round(med(all_q) * 100, 1) if all_q else None,
        }

    return {"rows": per_ticker, "total": total}


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
    atomic_write_json(OI_TICKERS_FILE, current, indent=2)
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


FUTURES_DISK_CACHE = "futures_cache.json"
FUTURES_CACHE_MAX_AGE_DAYS = 7

# In-memory кэш фьючерсных стратегий.
# Заполняется при старте из файла (мгновенно) или по кнопке "Обновить контракты".
_futures_settings_cache: dict[str, StrategySettings] | None = None
_futures_cache_lock = threading.Lock()
_futures_reload_running = threading.Event()  # установлен пока идёт загрузка из API


def _futures_cache_to_disk(data: dict[str, dict]) -> None:
    """Сохраняет сырые данные (dict, не StrategySettings) в JSON-файл."""
    try:
        atomic_write_json(FUTURES_DISK_CACHE, {"saved_at": time.time(), "contracts": data})
    except Exception as e:
        logger.warning(f"futures: не удалось записать кэш на диск: {e}")


def _futures_cache_from_disk() -> tuple[dict[str, dict] | None, float]:
    """Читает кэш с диска. Возвращает (данные, возраст_в_днях) или (None, inf)."""
    if not os.path.exists(FUTURES_DISK_CACHE):
        return None, float("inf")
    try:
        with open(FUTURES_DISK_CACHE, encoding="utf-8") as f:
            raw = json.load(f)
        age_days = (time.time() - raw.get("saved_at", 0)) / 86400
        return raw.get("contracts", {}), age_days
    except Exception as e:
        logger.warning(f"futures: не удалось прочитать кэш с диска: {e}")
        return None, float("inf")


# basic_asset коды из Tinkoff API → человекочитаемое название базиса.
# Используется в двух местах: как подпись категории в TOC и как тултип чипа.
_BASE_ASSET_LABEL: dict[str, str] = {
    # Нефть и нефтепродукты
    "BR": "Нефть Brent",
    "CL": "Нефть WTI",
    "NG": "Газ природный (США)",
    "TTF": "Газ TTF (Европа)",
    "NGM": "Газ микро (США)",
    "AI92": "Бензин АИ-92",
    "AI95": "Бензин АИ-95",
    "DT": "Дизельное топливо",
    # Металлы
    "GD": "Золото",
    "GOLD": "Золото",
    "GLD": "Золото $",
    "GLDRUB_TOM": "Золото ₽",
    "SLVR": "Серебро",
    "PD": "Палладий",
    "PT": "Платина",
    "AL": "Алюминий",
    "CU": "Медь",
    "NI": "Никель",
    "ZN": "Цинк",
    # Агро
    "W": "Пшеница",
    "SRW": "Пшеница (SRW)",
    "SUGAR": "Сахар мировой",
    "SUGR": "Сахар российский",
    "OJ": "Апельсиновый сок",
    "CC": "Какао",
    "KC": "Кофе",
    # Валюта
    "Si": "USD/RUB",
    "Eu": "EUR/RUB",
    "CNYRUB_TOM": "CNY/RUB",
    "GBPRUB_TOM": "GBP/RUB",
    "HKDRUB_TOM": "HKD/RUB",
    "TRYRUB_TOM": "TRY/RUB",
    "AMDRUB_TOM": "AMD/RUB",
    "KZTRUB_TOM": "KZT/RUB",
    "EUR_USD000UTSTOM": "EUR/USD",
    # Индексы РФ
    "MX": "Индекс МосБиржи",
    "RI": "Индекс РТС",
    "MM": "Индекс МосБиржи мини",
    # Иностр. акции / крипто
    "BABA": "Alibaba (BABA)",
    "BIDU": "Baidu (BIDU)",
    "IBIT": "Bitcoin ETF IBIT",
    "ETHA": "Ethereum ETF ETHA",
}

_METAL_BASES = frozenset({
    "GD", "GOLD", "GLD", "GLDRUB_TOM", "SLVR", "PD", "PT", "AL", "CU", "NI", "ZN",
})
_INDEX_BASES = frozenset({"MX", "RI", "MM"})
_CURRENCY_BASES = frozenset({
    "Si", "Eu", "CNYRUB_TOM", "GBPRUB_TOM", "HKDRUB_TOM",
    "TRYRUB_TOM", "AMDRUB_TOM", "KZTRUB_TOM", "EUR_USD000UTSTOM",
})
_FOREIGN_STOCK_BASES = frozenset({"BABA", "BIDU", "IBIT", "ETHA"})

# Товарные базисы (нефть/газ/агро), которые не металл, не индекс, не валюта.
_COMMODITY_BASES = frozenset(_BASE_ASSET_LABEL) - _METAL_BASES - _INDEX_BASES - _CURRENCY_BASES - _FOREIGN_STOCK_BASES

_RU_STOCK_BASE_TICKERS = frozenset({
    "ABIO", "AFKS", "AFLT", "ALRS", "ASTR", "BANE", "BELU", "BSPB", "CBOM", "CHMF",
    "DOMRF", "ENPG", "FEES", "FESH", "FLOT", "GAZP", "GMKN", "HEAD", "HYDR", "IRAO",
    "IVAT", "KMAZ", "LEAS", "LENT", "LKOH", "MAGN", "MDMG", "MGNT", "MIPO", "MOEX",
    "MREDC", "MTLR", "MTSS", "MVID", "NLMK", "NVTK", "OZON", "PHOR", "PIKK", "PLZL",
    "POSI", "RASP", "RENI", "RNFT", "ROSN", "RTKM", "RTKMP", "RUAL", "SBER", "SBERP",
    "SFIN", "SGZH", "SIBN", "SMLT", "SNGS", "SNGSP", "SOFL", "SVCB", "T", "TATN",
    "TATNP", "TRNFP", "UPRO", "VKCO", "VTBR", "WUSH", "X5", "YDEX",
})


_FUTURES_CATEGORY_ORDER = ("Акции", "Сырьё", "Металлы", "Индексы", "Валюта")


def _futures_category(base: str) -> str:
    """Категория для группировки чипов дашборда: акции / сырьё / металлы /
    индексы / валюта — без «прочего». Базис, которого нет ни в одном
    известном списке (металлы/сырьё/индексы/валюта/иностр. акции), почти
    всегда сам является тикером акции МосБиржи — относим его к «Акции»,
    а не сваливаем в неинформативную мусорную категорию."""
    if base in _METAL_BASES:
        return "Металлы"
    if base in _COMMODITY_BASES:
        return "Сырьё"
    if base in _INDEX_BASES:
        return "Индексы"
    if base in _CURRENCY_BASES:
        return "Валюта"
    return "Акции"


# ticker → категория / basic_asset, пересчитываются вместе в _build_strategy_settings.
_futures_category_by_ticker: dict[str, str] = {}
_futures_base_by_ticker: dict[str, str] = {}


def _build_strategy_settings(contracts: dict[str, dict]) -> dict[str, StrategySettings]:
    """Строит dict[ticker → StrategySettings] из сохранённых данных контрактов."""
    global _futures_category_by_ticker
    stock_settings = {s.ticker: s for s in _config.trade_strategy_settings}
    ma = _config.mega_alerts_settings
    result: dict[str, StrategySettings] = {}
    categories: dict[str, str] = {}
    for base, info in contracts.items():
        base_st = stock_settings.get(base)
        if base_st:
            sig_settings = dict(base_st.settings)
            max_lots = base_st.max_lots_per_order
        else:
            sig_settings = {
                "SIGNAL_THRESHOLD": ma.signal_threshold,
                "LONG_TAKE": ma.long_take, "LONG_STOP": ma.long_stop,
                "SHORT_TAKE": ma.short_take, "SHORT_STOP": ma.short_stop,
                "SIGNAL_ONLY": "1",
            }
            max_lots = ma.max_lots_per_order
        result[info["ticker"]] = StrategySettings(
            name="OICompositeStrategy",
            figi=info["figi"],
            ticker=info["ticker"],
            max_lots_per_order=max_lots,
            settings=sig_settings,
            lot_size=info["lot"],
            short_enabled_flag=info["short_enabled_flag"],
            is_future=True,
            margin_per_lot=info["margin_per_lot"],
            point_value=info["point_value"],
            candle_interval_min=1,
        )
        categories[info["ticker"]] = _futures_category(base)
    _futures_category_by_ticker = categories
    global _futures_base_by_ticker
    _futures_base_by_ticker = {info["ticker"]: base for base, info in contracts.items()}
    return result


def _futures_settings_by_ticker() -> dict[str, StrategySettings]:
    global _futures_settings_cache
    if _futures_settings_cache is not None:
        return _futures_settings_cache
    with _futures_cache_lock:
        if _futures_settings_cache is not None:
            return _futures_settings_cache
        # Первый запрос — грузим с диска, фильтруем истекшие контракты
        contracts, age_days = _futures_cache_from_disk()
        if contracts is not None:
            now = datetime.datetime.now(datetime.timezone.utc)
            valid, expired = {}, []
            for base, info in contracts.items():
                exp_str = info.get("expiration_date")
                if exp_str:
                    try:
                        exp = datetime.datetime.fromisoformat(exp_str)
                        if exp.tzinfo is None:
                            exp = exp.replace(tzinfo=datetime.timezone.utc)
                        if exp > now:
                            valid[base] = info
                        else:
                            expired.append(info["ticker"])
                    except Exception:
                        valid[base] = info  # не разобрали дату — оставляем
                else:
                    valid[base] = info  # старый кэш без даты — оставляем
            if expired:
                logger.info(f"futures: истекло {len(expired)} контрактов: {expired[:5]}{'...' if len(expired)>5 else ''}, обновите вручную кнопкой 🔄")
            _futures_settings_cache = _build_strategy_settings(valid)
            logger.info(f"futures: загружено {len(_futures_settings_cache)} актуальных контрактов из кэша (возраст {age_days:.1f} дн.)")
        else:
            _futures_settings_cache = {}
    return _futures_settings_cache


def _load_futures_from_api() -> dict[str, dict]:
    """Загружает контракты из API, возвращает сырые данные для сохранения на диск."""
    ft = _config.futures_trading_settings
    if not ft.enabled or not ft.base_tickers:
        return {}

    print(f"[futures] Батч-загрузка {len(ft.base_tickers)} базовых активов…", flush=True)
    bulk = _instrument_service.futures_by_base_tickers_bulk(ft.base_tickers, margin_delay=4.5)
    print(f"[futures] API вернул {len(bulk)} контрактов", flush=True)

    contracts: dict[str, dict] = {}
    for base, (future_info, figi) in bulk.items():
        contracts[base] = {
            "ticker": future_info.ticker,
            "figi": figi,
            "lot": future_info.lot,
            "short_enabled_flag": future_info.short_enabled_flag,
            "margin_per_lot": future_info.margin_per_lot,
            "point_value": future_info.point_value,
            "expiration_date": future_info.expiration_date.isoformat(),
        }
    return contracts


def _reload_futures_bg() -> None:
    """Фоновый поток: загружает контракты из API и обновляет кэш."""
    global _futures_settings_cache
    try:
        contracts = _load_futures_from_api()
        if contracts:
            _futures_cache_to_disk(contracts)
        with _futures_cache_lock:
            _futures_settings_cache = _build_strategy_settings(contracts)
        logger.info(f"futures: обновлено {len(_futures_settings_cache)} контрактов")
        print(f"[futures] Готово: {len(_futures_settings_cache)} контрактов", flush=True)
    except Exception as e:
        logger.error(f"futures: ошибка обновления: {e}")
    finally:
        _futures_reload_running.clear()


def _start_futures_reload_bg() -> bool:
    """Запускает фоновое обновление если оно ещё не идёт. Возвращает True если запустили."""
    if _futures_reload_running.is_set():
        return False
    _futures_reload_running.set()
    t = threading.Thread(target=_reload_futures_bg, daemon=True, name="futures-reload")
    t.start()
    return True


def _all_settings_by_ticker() -> dict[str, StrategySettings]:
    """Акции + фьючерсы (фьючерсы приоритетнее при совпадении тикера)."""
    merged = dict(_strategy_settings_by_ticker())
    merged.update(_futures_settings_by_ticker())
    return merged


def _wire_backtest_providers(strategy, ticker: str, days: int, offset_days: int = 0):
    """Best-effort инъекция OI/index-провайдеров и истории (как в
    _save_backtest_history_one). Не критично для accel/NW — тихо пропускаем."""
    try:
        _wire_history(strategy)
    except Exception:
        pass
    try:
        from oi_layers import OiBacktestProvider
        oi_prov = OiBacktestProvider.load()
        if oi_prov.has_data(ticker):
            for setter, fn in (("set_inst_oi_provider", "inst_oi_score"),
                               ("set_retail_contra_provider", "retail_contra_score"),
                               ("set_delta_quadrant_provider", "delta_quadrant_score"),
                               ("set_oi_absorption_provider", "absorption_score"),
                               ("set_squeeze_provider", "squeeze_score"),
                               ("set_oi_regime_provider", "oi_instability_score")):
                if hasattr(strategy, setter):
                    getattr(strategy, setter)(getattr(oi_prov, fn))
    except Exception:
        pass
    try:
        idx_prov = _index_context_provider_for_backtest(days, offset_days)
        if idx_prov is not None and hasattr(strategy, "set_index_context_provider"):
            strategy.set_index_context_provider(idx_prov.score)
    except Exception:
        pass


def _system_candles(ticker, settings, days: int):
    """Свечи для системного прогона БЕЗ цепочки контрактов. Цепочный вариант
    (_get_backtest_candles → get_candles_cached_futures_chain) на cache-miss
    дёргает futures_chain_by_figi → live API, который в этом окружении падает
    ('Client' has no attribute 'market_data') И ВЫБРАСЫВАЕТ уже готовый кэш —
    отсюда ложное «нет свечей». Здесь прямой get_candles_cached (локальный
    кэш + D1, тот же путь, что у get_trade_chart и обычного бэктеста), с
    финальным падением на ЧИСТЫЙ локальный кэш без сети."""
    figi = settings.figi
    interval = 5 if getattr(settings, "is_future", False) else getattr(settings, "candle_interval_min", 5)
    try:
        c = get_candles_cached(ticker, figi, days, _market_data, _db, candle_interval_min=interval)
        if c:
            return c
    except Exception as e:
        logger.info("system_backtest: get_candles_cached(%s) упал (%s) — пробую локальный кэш", ticker, e)
    try:
        from candle_archive import _load_local, _row_to_candle
        rows = _load_local(ticker, interval)
        if rows:
            cutoff = (datetime.datetime.now(datetime.timezone.utc)
                      - datetime.timedelta(days=days)).isoformat()
            rows = [r for r in rows if r.get("time", "") >= cutoff]
            cs = [_row_to_candle(r) for r in rows]
            cs.sort(key=lambda x: x.time)
            return cs
    except Exception as e:
        logger.info("system_backtest: локальный кэш %s недоступен (%s)", ticker, e)
    return []


def run_system_backtest(days: int = 90, split_frac: float = 0.6,
                        cost_atr: float = 0.12, tickers: list | None = None) -> dict:
    """СИСТЕМНЫЙ ПРОГОН: каждый тикер через ЖИВУЮ стратегию (composite/accel/NW),
    единый бар-за-баром симулятор (system_backtest.simulate_analyze_strategy) →
    сопоставимая метрика exp_atr/win/N на held-out окне (прогрев=train, сигналы
    =OOS). Отражает то, как система реально торгует, а не всегда composite.

    Возвращает {rows:[...], by_strategy:{...}, days, cost_atr, split_frac}.
    """
    import dataclasses
    import system_backtest as sysbt

    by_ticker = _all_settings_by_ticker()
    strat_map = _config.futures_trading_settings.strategy_map
    override = _config.trading_settings.strategy_override
    names = list(tickers) if tickers else list(by_ticker.keys())

    rows = []
    for ticker in names:
        settings = by_ticker.get(ticker)
        if settings is None:
            rows.append({"ticker": ticker, "error": "нет в settings"})
            continue
        base = _futures_base_by_ticker.get(ticker, ticker)
        live_name = sysbt.live_strategy_name(ticker, base, strat_map, override,
                                             default=settings.name)
        try:
            live_settings = dataclasses.replace(_backtest_strategy_settings(settings),
                                                name=live_name)
            strategy = StrategyFactory.new_factory(live_name, live_settings)
            if strategy is None:
                rows.append({"ticker": ticker, "strategy": live_name,
                             "error": "стратегия не создана"})
                continue
            # Загрузка свечей — отдельно: cache-miss уходит в live-fetch, который
            # на части инструментов падает (напр. тонкие фьючерсы без кэша). Это
            # НЕ ошибка прогона — тикер просто пропускаем (нет данных для оценки).
            try:
                candles = _system_candles(ticker, settings, days)
            except Exception as cx:
                rows.append({"ticker": ticker, "strategy": live_name,
                             "skipped": "нет свечей в кэше"})
                logger.info("system_backtest: %s без свечей (%s)", ticker, cx)
                continue
            if not candles or len(candles) < 200:
                rows.append({"ticker": ticker, "strategy": live_name,
                             "skipped": "мало свечей"})
                continue
            _wire_backtest_providers(strategy, ticker, days)
            split_idx = int(len(candles) * split_frac)
            res = sysbt.simulate_analyze_strategy(strategy, candles, split_idx,
                                                  cost_atr=cost_atr)
            rows.append({
                "ticker": ticker, "base": base, "strategy": live_name,
                "n": res["n"], "win": round(res["win"], 3),
                "exp_atr": round(res["exp_atr"], 3),
                "bars": len(candles), "test_from": split_idx,
            })
        except Exception as ex:
            rows.append({"ticker": ticker, "strategy": live_name, "error": str(ex)})

    # Свод по стратегиям: суммарный N, взвешенная по N экспектанси, средний win.
    by_strategy: dict[str, dict] = {}
    for r in rows:
        if r.get("error") or not r.get("n"):
            continue
        agg = by_strategy.setdefault(r["strategy"], {"n": 0, "wsum": 0.0, "winsum": 0.0, "tickers": 0})
        agg["n"] += r["n"]
        agg["wsum"] += r["exp_atr"] * r["n"]
        agg["winsum"] += r["win"] * r["n"]
        agg["tickers"] += 1
    for name, agg in by_strategy.items():
        n = agg["n"] or 1
        agg["exp_atr"] = round(agg["wsum"] / n, 3)
        agg["win"] = round(agg["winsum"] / n, 3)
        del agg["wsum"], agg["winsum"]

    evaluated = sum(1 for r in rows if r.get("n") is not None and not r.get("error"))
    skipped = sum(1 for r in rows if r.get("skipped"))
    errored = sum(1 for r in rows if r.get("error"))
    return {"rows": rows, "by_strategy": by_strategy, "days": days,
            "cost_atr": cost_atr, "split_frac": split_frac,
            "evaluated": evaluated, "skipped": skipped, "errored": errored}


def get_trade_chart(ticker: str, days: int, atr_take: float, atr_stop: float) -> dict:
    """Свечи + бэктестовые сделки для графика: {candles, trades, ticker}."""
    from candle_archive import _candle_to_row  # уже импортирован через get_candles_cached
    by_ticker = _all_settings_by_ticker()
    strategy_settings = by_ticker.get(ticker)
    if strategy_settings is None:
        return {"error": f"{ticker}: нет в settings.ini/oi_tickers.json"}

    try:
        candles = get_candles_cached(ticker, strategy_settings.figi, days, _market_data, _db)
    except RequestError as e:
        return {"error": f"Tinkoff API: {e}"}
    if not candles:
        return {"error": f"{ticker}: нет свечей"}

    strategy = StrategyFactory.new_factory(strategy_settings.name, strategy_settings)
    if strategy is None:
        return {"error": f"{ticker}: стратегия не создана"}
    _wire_history(strategy)

    from oi_layers import OiBacktestProvider
    oi_prov = OiBacktestProvider.load()
    if oi_prov.has_data(ticker):
        strategy.set_inst_oi_provider(oi_prov.inst_oi_score)
        strategy.set_retail_contra_provider(oi_prov.retail_contra_score)
        strategy.set_delta_quadrant_provider(oi_prov.delta_quadrant_score)
        strategy.set_oi_absorption_provider(oi_prov.absorption_score)
        strategy.set_squeeze_provider(oi_prov.squeeze_score)
        strategy.set_oi_regime_provider(oi_prov.oi_instability_score)
        oi_hook = oi_prov.set_date
    else:
        oi_hook = None

    idx_prov = _index_context_provider_for_backtest(days)
    if idx_prov is not None and hasattr(strategy, "set_index_context_provider"):
        strategy.set_index_context_provider(idx_prov.score)
        if oi_hook is None:
            oi_hook = idx_prov.set_date
        else:
            _oi_hook0 = oi_hook
            def oi_hook(d, _h0=_oi_hook0, _p=idx_prov):
                _h0(d)
                _p.set_date(d)

    signals = strategy.backtest_scan_signals(candles, oi_date_hook=oi_hook)
    result = strategy.backtest_barriers(
        candles, signals=signals,
        atr_take_k=atr_take, atr_stop_k=atr_stop,
        return_trades=True,
    )
    trades_raw = result.get("trades", [])

    candle_rows = [_candle_to_row(c) for c in candles]

    trades_out = []
    for t in trades_raw:
        trades_out.append({
            "entry_time": t["entry_time"].isoformat() if t["entry_time"] else None,
            "exit_time": t["exit_time"].isoformat() if t["exit_time"] else None,
            "direction": t["direction"],
            "entry_price": t.get("entry_price"),
            "exit_price": t.get("exit_price"),
            "take_price": t.get("take_price"),
            "stop_price": t.get("stop_price"),
            "mfe": t.get("mfe"),
            "mae": t.get("mae"),
            "net_pct": round(t["net_pct"] * 100, 3),
            "r_multiple": round(t["r_multiple"], 2),
            "win": t["win"],
            "duration_min": t["duration_min"],
        })

    return {"ticker": ticker, "candles": candle_rows, "trades": trades_out}


def export_bar_scores_csv(ticker: str, days: int = 90) -> dict:
    """
    Экспорт CSV для AI-анализа: каждый M5-бар тикера со всеми method_scores,
    режимом, OHLCV и forward-return (+1/+5/+20 баров).
    Возвращает {"csv": "<строка>", "rows": N, "ticker": ticker} или {"error": ...}.
    """
    by_ticker = _all_settings_by_ticker()
    strategy_settings = by_ticker.get(ticker)
    if strategy_settings is None:
        return {"error": f"{ticker}: нет в settings.ini"}

    try:
        candles = get_candles_cached(ticker, strategy_settings.figi, days, _market_data, _db)
    except RequestError as e:
        return {"error": f"Tinkoff API: {e}"}
    if not candles:
        return {"error": f"{ticker}: нет свечей"}

    # используем OICompositeStrategy.scan_method_scores — даёт каждый бар
    from trade_system.strategies.oi_composite_strategy import OICompositeStrategy
    oi_settings = strategy_settings
    # если текущая стратегия не OI — временно создаём OI для скоринга
    oi_strat = OICompositeStrategy(oi_settings)
    _wire_history(oi_strat)

    rows = oi_strat.scan_method_scores(candles)
    if not rows:
        return {"error": f"{ticker}: scan_method_scores вернул пустой результат"}

    # добавляем OHLV и forward return
    from tinkoff.invest.utils import quotation_to_decimal
    def _f(q): return float(quotation_to_decimal(q))

    close_arr = [_f(c.close) for c in candles]
    high_arr  = [_f(c.high)  for c in candles]
    low_arr   = [_f(c.low)   for c in candles]
    open_arr  = [_f(c.open)  for c in candles]
    vol_arr   = [float(c.volume) for c in candles]

    # rows[i] соответствует candles[window + i]
    window = len(candles) - len(rows)

    score_names = sorted(rows[0]["scores"].keys()) if rows else []
    fieldnames = (
        ["time", "open", "high", "low", "close", "volume", "regime"]
        + score_names
        + ["fwd_ret_3", "fwd_ret_6", "fwd_ret_12", "fwd_ret_24", "fwd_ret_48"]
    )

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fieldnames)
    writer.writeheader()

    for i, row in enumerate(rows):
        ci = window + i  # индекс в candles
        close = close_arr[ci]

        def fwd(n):
            j = ci + n
            if j >= len(close_arr) or close == 0:
                return ""
            return round((close_arr[j] - close) / close * 100, 4)

        record = {
            "time": row["time"].isoformat() if hasattr(row["time"], "isoformat") else str(row["time"]),
            "open":   round(open_arr[ci], 4),
            "high":   round(high_arr[ci], 4),
            "low":    round(low_arr[ci], 4),
            "close":  round(close, 4),
            "volume": int(vol_arr[ci]),
            "regime": row["regime"],
            "fwd_ret_3":  fwd(3),
            "fwd_ret_6":  fwd(6),
            "fwd_ret_12": fwd(12),
            "fwd_ret_24": fwd(24),
            "fwd_ret_48": fwd(48),
        }
        for sn in score_names:
            record[sn] = round(row["scores"].get(sn, 0.0), 4)
        writer.writerow(record)

    return {"csv": buf.getvalue(), "rows": len(rows), "ticker": ticker}


BAR_SCORES_DIR = "data/bar_scores"


def list_bar_scores_files() -> list[dict]:
    """Список сохранённых CSV-файлов bar_scores с метаданными."""
    os.makedirs(BAR_SCORES_DIR, exist_ok=True)
    result = []
    for fname in sorted(os.listdir(BAR_SCORES_DIR)):
        if not fname.endswith(".csv"):
            continue
        path = os.path.join(BAR_SCORES_DIR, fname)
        stat = os.stat(path)
        result.append({
            "filename": fname,
            "size_kb": round(stat.st_size / 1024, 1),
            "mtime": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M"),
        })
    return result


def export_bar_scores_batch(tickers: list[str], days: int, yield_progress):
    """
    Серийная качка bar_scores для списка тикеров.
    yield_progress(ticker, status, rows, error) — колбэк для SSE.
    Сохраняет файлы в BAR_SCORES_DIR.
    """
    os.makedirs(BAR_SCORES_DIR, exist_ok=True)
    for ticker in tickers:
        try:
            result = export_bar_scores_csv(ticker, days)
            if "error" in result:
                yield_progress(ticker, "error", 0, result["error"])
                continue
            fname = f"{ticker}_{days}d.csv"
            path = os.path.join(BAR_SCORES_DIR, fname)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(result["csv"])
            yield_progress(ticker, "done", result["rows"], None)
        except Exception as e:
            yield_progress(ticker, "error", 0, str(e))


def export_trades_csv_all() -> str:
    """CSV со всеми трейдами из _last_full_trades: технические параметры +
    все method_scores + 5 свечей контекста (candle_context)."""
    with _last_full_trades_lock:
        all_trades = [(ticker, t) for ticker, trades in _last_full_trades.items()
                      for t in trades]
    if not all_trades:
        return ""

    # Собираем все имена методов из первого трейда с method_scores
    method_names: list[str] = []
    for _, t in all_trades:
        ms = t.get("method_scores") or {}
        if ms:
            method_names = sorted(ms.keys())
            break

    # Колонки базовые
    base_cols = [
        "ticker", "entry_time", "exit_time", "direction", "win",
        "r_multiple", "net_pct", "mfe_pct", "mae_pct",
        "entry_price", "exit_price", "take_price", "stop_price",
        "duration_min", "exit_reason", "regime", "entry_mode",
        "atr_pct", "l1_pct", "l1_above_ma50", "l1_trending_up",
        "l1_trending_down", "atr_ex_ratio", "agree_count", "against_count",
    ]
    # Колонки для 5 свечей контекста (c0 = самая старая, c4 = вход)
    candle_cols = []
    for ci in range(5):
        for field in ("t", "o", "h", "l", "c", "v"):
            candle_cols.append(f"c{ci}_{field}")
    # method_scores
    method_cols = [f"ms_{n}" for n in method_names]

    fieldnames = base_cols + candle_cols + method_cols

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()

    for ticker, t in all_trades:
        ctx = t.get("candle_context") or []
        # дополняем до 5 пустышками слева если свечей меньше
        while len(ctx) < 5:
            ctx = [{}] + ctx

        row: dict = {
            "ticker": ticker,
            "entry_time": str(t.get("entry_time", ""))[:16],
            "exit_time": str(t.get("exit_time", ""))[:16],
            "direction": t.get("direction", ""),
            "win": int(t.get("win", False)),
            "r_multiple": round(t.get("r_multiple", 0.0), 3),
            "net_pct": round(t.get("net_pct", 0.0) * 100, 3),
            "mfe_pct": round((t.get("mfe") or 0.0) * 100, 3),
            "mae_pct": round((t.get("mae") or 0.0) * 100, 3),
            "entry_price": t.get("entry_price", ""),
            "exit_price": t.get("exit_price", ""),
            "take_price": t.get("take_price", ""),
            "stop_price": t.get("stop_price", ""),
            "duration_min": t.get("duration_min", ""),
            "exit_reason": t.get("exit_reason", ""),
            "regime": t.get("regime", ""),
            "entry_mode": t.get("entry_mode", ""),
            "atr_pct": round(t.get("atr_pct") or 0.0, 5),
            "l1_pct": t.get("l1_pct", ""),
            "l1_above_ma50": t.get("l1_above_ma50", ""),
            "l1_trending_up": t.get("l1_trending_up", ""),
            "l1_trending_down": t.get("l1_trending_down", ""),
            "atr_ex_ratio": t.get("atr_ex_ratio", ""),
            "agree_count": t.get("agree_count", ""),
            "against_count": t.get("against_count", ""),
        }
        # свечи контекста
        for ci, candle in enumerate(ctx):
            for field in ("t", "o", "h", "l", "c", "v"):
                row[f"c{ci}_{field}"] = candle.get(field, "")
        # method_scores
        ms = t.get("method_scores") or {}
        for n in method_names:
            row[f"ms_{n}"] = round(ms.get(n, 0.0), 4)

        writer.writerow(row)

    return buf.getvalue()


    """
    Снимок того, КАК сейчас реально считается композит для тикера — на
    живой истории (data/history.json через HistoryStore, не пустой
    BacktestHistoryStore): Hedge-вес метода (persist в oi_weights.json),
    regime_probs текущего окна, RMT-redundancy по режиму (Layer 4),
    в каких режимах накоплена своя корреляционная матрица. Кнопка
    "Диагностика стратегии" в дашборде — иначе всё это видно только
    логами/чтением кода.
    """
    by_ticker = _all_settings_by_ticker()
    strategy_settings = by_ticker.get(ticker)
    if strategy_settings is None:
        return {"ready": False, "error": f"{ticker}: нет в settings.ini/oi_tickers.json"}

    candles = get_candles_cached(ticker, strategy_settings.figi, days, _market_data, _db)
    if not candles:
        return {"ready": False, "error": f"{ticker}: нет истории свечей"}

    strategy = StrategyFactory.new_factory(strategy_settings.name, strategy_settings)
    if strategy is None or not hasattr(strategy, "diagnostics_snapshot"):
        return {"ready": False, "error": f"{ticker}: стратегия не поддерживает diagnostics_snapshot"}

    if hasattr(strategy, "set_history"):
        strategy.set_history(HistoryStore(), PercentileCalibrator())

    snapshot = strategy.diagnostics_snapshot(candles)
    snapshot["ticker"] = ticker
    return snapshot


def filter_active_tickers(tickers: list[str], dedup_by_issuer: bool, top_pct: float) -> dict:
    """
    Применяет дедуп по эмитенту + отсев по востребованности (см.
    issuer_filter.select_top_tickers) к выбранному в UI списку тикеров.

    Тикеры из settings.ini (вручную отобранные, без дублей) всегда
    остаются — demand у них приравнивается к "бесконечности", чтобы они
    не вытеснялись и не отсекались top_pct, но всё равно участвовали в
    дедупе как "сильный" вариант, если у эмитента есть OI-дубль.
    """
    # Дедуп не нужен если выключен
    if not dedup_by_issuer:
        # Убираем дубли (один тикер может быть и в акциях, и в фьючерсах)
        seen: set[str] = set()
        unique = [t for t in tickers if not (t in seen or seen.add(t))]
        return {"kept": unique, "dropped": []}

    settings_tickers = {s.ticker for s in _config.trade_strategy_settings}
    futures_tickers = set(_futures_settings_by_ticker().keys())
    oi_tickers = load_oi_tickers()

    # Убираем дубли перед дедупом
    seen_set: set[str] = set()
    tickers = [t for t in tickers if not (t in seen_set or seen_set.add(t))]

    infos = []
    for ticker in tickers:
        if ticker in settings_tickers or ticker in futures_tickers:
            # Акции из settings.ini и фьючерсы — всегда оставляем, demand=inf
            # чтобы top_pct их не отрезал. У каждого фьючерса уникальный
            # тикер (SiU6, BRU6 и т.д.) — дедуп по эмитенту не нужен.
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

    configured = set(_all_settings_by_ticker().keys())
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


def _model_stats_from_trades(trades: list[dict]) -> dict:
    """Та же agree/disagree-агрегация, что в backtest_barriers.model_stats
    (oi_composite_strategy.py) и run_portfolio_sim — нужна здесь отдельно,
    т.к. walk-forward режим считает сделки по дням, а model_stats из
    backtest_barriers по одному дню статистически бесполезен."""
    tally = {m: {"agree_n": 0, "agree_win": 0, "agree_dur": 0.0, "disagree_n": 0, "disagree_win": 0, "disagree_dur": 0.0}
             for m in ("m1", "m2", "m3")}
    for t in trades:
        dir_sign = 1 if t["direction"] == "LONG" else -1
        dur = t.get("duration_min", 0.0)
        for m in ("m1", "m2", "m3"):
            m_sc = t.get(m, 0.0)
            if m_sc == 0:
                continue
            tl = tally[m]
            if (m_sc > 0) == (dir_sign > 0):
                tl["agree_n"] += 1
                tl["agree_win"] += int(t["win"])
                tl["agree_dur"] += dur
            else:
                tl["disagree_n"] += 1
                tl["disagree_win"] += int(t["win"])
                tl["disagree_dur"] += dur
    return {
        m.upper() + "_CLUSTER": {
            "agree_n": tl["agree_n"],
            "agree_win_rate": tl["agree_win"] / tl["agree_n"] if tl["agree_n"] else None,
            "agree_avg_duration_min": tl["agree_dur"] / tl["agree_n"] if tl["agree_n"] else None,
            "disagree_n": tl["disagree_n"],
            "disagree_win_rate": tl["disagree_win"] / tl["disagree_n"] if tl["disagree_n"] else None,
            "disagree_avg_duration_min": tl["disagree_dur"] / tl["disagree_n"] if tl["disagree_n"] else None,
        }
        for m, tl in tally.items()
    }


def _trades_list_compact(trades: list[dict]) -> list[dict]:
    """Компактный список сделок для drill-down на дашборде.
    Из method_scores берём только топ-3 за и топ-3 против (по abs score),
    чтобы не гонять по сети все ~40 методов на каждую сделку."""
    out = []
    for t in trades:
        # top_agree/top_against уже вычислены в backtest_barriers как [(name, score), ...]
        for_m = [(n, s) for n, s in (t.get("top_agree") or [])[:3]]
        against_m = [(n, s) for n, s in (t.get("top_against") or [])[:3]]
        out.append({
            "t": str(t.get("entry_time", ""))[:16],  # YYYY-MM-DD HH:MM
            "d": t.get("direction", "?")[0],  # L / S
            "w": int(t.get("win", False)),
            "r": round(t.get("r_multiple", 0.0), 2),
            "mfe": round((t.get("mfe") or 0.0) * 100, 3),
            "mae": round((t.get("mae") or 0.0) * 100, 3),
            "ep": round(t.get("entry_price") or 0.0, 4),
            "xp": round(t.get("exit_price") or 0.0, 4),
            "tp": round(t.get("take_price") or 0.0, 4),
            "sp": round(t.get("stop_price") or 0.0, 4),
            "l1pct": round(t.get("l1_pct") or -1.0, 3),  # позиция цены в дневном hi-lo [0..1], -1 если нет
            "xr": t.get("exit_reason", ""),  # почему закрыли: take / stop / timeout
            "fa": [[n, round(s, 2)] for n, s in for_m],
            "ag": [[n, round(s, 2)] for n, s in against_m],
            # Полный разбор по ВСЕМ методам, высказавшимся на входе (|score|>=0.02) —
            # чтобы «за/против» было видно целиком (тултип на экране) и полностью
            # попадало в кнопку копирования, а не только топ-3/5.
            "ms": sorted(
                [[n, round(v, 2)] for n, v in (t.get("method_scores") or {}).items() if abs(v) >= 0.02],
                key=lambda x: -x[1]
            ),
        })
    return out


def _method_stats_from_trades(trades: list[dict]) -> dict:
    """Per-method agree/disagree attribution из списка сделок.
    Каждая сделка должна иметь method_scores (dict метод→скор) и direction/win.
    Берём method_scores_shadow, если есть — для включённых методов он совпадает
    с method_scores, а для выключенных показывает гипотетический винрейт (метод
    не голосовал и не обучался, но статистика по нему всё равно видна).

    Молчаливые методы (появлялись во входе, но всегда со скором <0.02) тоже
    включаются в результат с нулевыми счётчиками — чтобы дашборд мог показать
    статус «не голосовал в этой сессии» отдельно от «нет провайдера» и «выкл».
    """
    def _empty():
        return {"agree_n": 0, "agree_win": 0, "disagree_n": 0, "disagree_win": 0,
                "alt_flips": 0, "alt_stronger": 0, "classic_stronger": 0, "alt_compared": 0}
    tally: dict[str, dict] = {}
    seen: set[str] = set()   # все имена методов, встречавшиеся в method_scores,
                             # даже если ни разу не преодолели порог 0.02
    for t in trades:
        dir_sign = 1 if t["direction"] == "LONG" else -1
        scores = (t.get("method_scores_shadow") or t.get("method_scores", {}))
        classic = t.get("method_scores_classic") or {}
        for mname, m_sc in scores.items():
            seen.add(mname)
            e = tally.setdefault(mname, _empty())
            # Сравнение классика vs альт (если стратегия прислала classic-снапшот).
            # alt_flips = процент сделок, где alt перевернул знак классики;
            # alt_stronger / classic_stronger = кто сильнее по модулю.
            if mname in classic:
                cs = classic[mname]
                if abs(cs) >= 0.02 or abs(m_sc) >= 0.02:
                    e["alt_compared"] += 1
                    if (cs > 0) != (m_sc > 0) and cs != 0 and m_sc != 0:
                        e["alt_flips"] += 1
                    if abs(m_sc) > abs(cs) + 0.01:
                        e["alt_stronger"] += 1
                    elif abs(cs) > abs(m_sc) + 0.01:
                        e["classic_stronger"] += 1
            if abs(m_sc) < 0.02:
                continue
            if (m_sc > 0) == (dir_sign > 0):
                e["agree_n"] += 1
                e["agree_win"] += int(t["win"])
            else:
                e["disagree_n"] += 1
                e["disagree_win"] += int(t["win"])
    for mname in seen:
        tally.setdefault(mname, _empty())
    return {
        mname: {
            "agree_n": e["agree_n"],
            "agree_win": e["agree_win"],
            "agree_win_rate": e["agree_win"] / e["agree_n"] if e["agree_n"] else None,
            "disagree_n": e["disagree_n"],
            "disagree_win": e["disagree_win"],
            "disagree_win_rate": e["disagree_win"] / e["disagree_n"] if e["disagree_n"] else None,
            "alt_flip_rate": (e["alt_flips"] / e["alt_compared"]) if e["alt_compared"] else None,
            "alt_stronger_rate": (e["alt_stronger"] / e["alt_compared"]) if e["alt_compared"] else None,
            "classic_stronger_rate": (e["classic_stronger"] / e["alt_compared"]) if e["alt_compared"] else None,
            "alt_compared": e["alt_compared"],
        }
        for mname, e in tally.items()
    }


def _merge_strategy_method_meta(stats: dict, strategy_ms: dict | None) -> dict:
    """Обогащает stats из _method_stats_from_trades полями `hedge_weight` и
    `disabled` из method_stats стратегии (у неё есть доступ к весам и списку
    выключенных, у per-trade подсчёта — нет). Для методов, которых нет в стратегии,
    значения остаются None — на дашборде они видны со статусом «не голосовал»."""
    if not strategy_ms:
        return stats
    for name, s in strategy_ms.items():
        target = stats.setdefault(name, {"agree_n": 0, "agree_win": 0, "agree_win_rate": None,
                                          "disagree_n": 0, "disagree_win": 0, "disagree_win_rate": None})
        if s.get("hedge_weight") is not None:
            target["hedge_weight"] = s["hedge_weight"]
        if "disabled" in s:
            target["disabled"] = s["disabled"]
    return stats


def _method_stats_by_regime_from_trades(trades: list[dict]) -> dict:
    """Та же attribution, что _method_stats_from_trades, но раздельно по
    regime сделки (поле "regime" уже пишется в каждую trade-запись, см.
    backtest_barriers/record_trade) — чтобы сравнивать win% метода в
    разных рыночных условиях, а не смешивать их в одну цифру."""
    by_regime: dict[str, list[dict]] = defaultdict(list)
    for t in trades:
        by_regime[t.get("regime") or "unknown"].append(t)
    return {regime: _method_stats_from_trades(rt) for regime, rt in by_regime.items()}


def _what_if_from_trades(trades: list[dict]) -> dict:
    """Та же идея, что what_if в run_portfolio_sim, но без эквити-симуляции
    (на одном тикере счёт не строим) — просто n_trades/win_rate/avg_r/
    expectancy_pct на подмножестве сделок, где модель(и) согласны с
    направлением. Закрывает жалобу «нет разделения по одной модели/2 из 3»
    для таблицы одного тикера (раньше там был только общий model_stats)."""
    def _agrees(t: dict, m: str) -> bool:
        sc = t.get(m, 0.0)
        return sc != 0 and (sc > 0) == (t["direction"] == "LONG")

    def _stats(subset: list[dict]) -> dict:
        n = len(subset)
        if n == 0:
            return {"n_trades": 0, "win_rate": None, "avg_r": None, "expectancy_pct": None}
        return {
            "n_trades": n,
            "win_rate": sum(1 for t in subset if t["win"]) / n,
            "avg_r": sum(t["r_multiple"] for t in subset) / n,
            "expectancy_pct": sum(t["net_pct"] for t in subset) / n,
        }

    what_if = {}
    for m in ("m1", "m2", "m3"):
        what_if[m.upper() + "_CLUSTER_ONLY"] = _stats([t for t in trades if _agrees(t, m)])
    what_if["ALL_THREE_AGREE"] = _stats(
        [t for t in trades if all(_agrees(t, m) for m in ("m1", "m2", "m3"))])
    what_if["TWO_OF_THREE_AGREE"] = _stats(
        [t for t in trades if sum(_agrees(t, m) for m in ("m1", "m2", "m3")) >= 2])
    return what_if


ATR_REOPT_MIN_NEW_TRADES = 15   # переоптимизировать не каждый день, а раз в N новых сделок —
                                # меньше "точек выбора" -> меньше шансов у шума выиграть argmax
ATR_SHRINK_K = 8                # псевдо-наблюдения к fixed-бейзлайну (как REGIME_SHRINKAGE_K в history.py)
ATR_MIN_EDGE_SEM = 2.0          # ATR-кандидат должен превосходить fixed минимум на 2 своих SEM;
                                # 1.0 было слишком мягко — шум на 12-16 eval-сделках регулярно проходил порог


def _shrunk_score(trades: list[dict], fixed_pct: float, k: int = ATR_SHRINK_K) -> tuple[float, float]:
    """Shrinkage-оценка expectancy ATR-кандидата на маленькой/шумной выборке:
    тянет к fixed-бейзлайну (а не к голому средству), сила тяги — k псевдо-
    наблюдений, по аналогии с REGIME_SHRINKAGE_K в history.py. Без этого
    argmax по сетке (3 take × 3 stop × 5 scale_exp = 45 кандидатов) почти
    всегда выбирает комбинацию, выигравшую за счёт пары случайных сделок в
    eval-окне ("optimizer's curse") — отсюда систематический проигрыш ATR
    walk-forward fixed-режиму, который ничего не подгоняет. Возвращает
    (shrunk_score, sem) — sem нужен дальше для проверки значимости edge."""
    n = len(trades)
    if n == 0:
        return fixed_pct, 0.0
    vals = [t["net_pct"] for t in trades]
    raw = sum(vals) / n
    sem = statistics.pstdev(vals) / (n ** 0.5) if n > 1 else abs(raw)
    shrunk = (n * raw + k * fixed_pct) / (n + k)
    return shrunk, sem


def run_backtest_one(
        ticker: str, days: int, atr_take_ks: list[float], atr_stop_ks: list[float],
        tariff: str | None = None, atr_scale_exps: list[float] | None = None,
        progress: dict | None = None, offset_days: int = 0,
        adaptive_narrative: bool = False, adaptive_lasso: bool = False,
        block_ranging: bool = False,
        disabled_methods: list[str] | None = None,
        inverted_methods: list[str] | None = None,
) -> tuple[list[dict], dict | None]:
    """
    Прогоняет бэктест по одному тикеру. Возвращает (rows, history_data):
    rows — список строк-результатов (как в compare_take_stop.py: fixed +
    лучшая ATR-комбинация), либо строка с ошибкой и советом, если тикер упал;
    history_data — накопленные за этот прогон дневные скоры/сделки
    (BacktestHistoryStore._data[ticker]) или None при ошибке/нет данных.
    Раньше эта история собиралась (_wire_history) и сразу выбрасывалась —
    "сохранить историю" потом гоняла отдельный, более простой бэктест с нуля
    заново. Теперь оставляем её доступной вызывающему, чтобы сохранение могло
    взять уже посчитанное вместо повторного прогона (см. save_backtest_history).
    """
    if progress is None:
        progress = _get_progress_proxy()
    by_ticker = _all_settings_by_ticker()
    rows: list[dict] = []
    _ticker_full_trades: list[dict] = []

    strategy_settings = by_ticker.get(ticker)
    if strategy_settings is None:
        rows.append({"ticker": ticker, "mode": "ошибка", "error": "нет в settings.ini"})
        _set_progress(progress, ticker, "ошибка")
        return rows, None, {}

    t0 = time.monotonic()
    logger.info(f"{ticker}: получаю историю свечей ({days} дн.)...")
    _set_progress(progress, ticker, "загрузка свечей")
    try:
        strategy = StrategyFactory.new_factory(strategy_settings.name, _backtest_strategy_settings(strategy_settings))
        if disabled_methods and hasattr(strategy, "set_disabled_methods"):
            strategy.set_disabled_methods(disabled_methods)
        if inverted_methods and hasattr(strategy, "set_inverted_methods"):
            strategy.set_inverted_methods(inverted_methods)
        bt_store = _wire_history_returning(strategy)
        if strategy is None or not hasattr(strategy, "backtest_barriers"):
            rows.append({"ticker": ticker, "mode": "пропуск",
                         "error": "стратегия не поддерживает backtest_barriers"})
            _set_progress(progress, ticker, "пропуск")
            return rows, None, {}

        try:
            candles = _get_backtest_candles(ticker, strategy_settings, days, offset_days)
        except RequestError as ex:
            rows.append({"ticker": ticker, "mode": "ошибка API", "error": str(ex.details)})
            _set_progress(progress, ticker, "ошибка API")
            return rows, None, {}
        except Exception as ex:
            rows.append({"ticker": ticker, "mode": "нет истории", "error": str(ex)})
            _set_progress(progress, ticker, "нет истории")
            return rows, None, {}

        if not candles:
            rows.append({"ticker": ticker, "mode": "нет истории", "error": ""})
            _set_progress(progress, ticker, "нет истории")
            return rows, None, {}

        logger.info(f"{ticker}: {len(candles)} свечей за {time.monotonic() - t0:.1f}с, считаю сигналы "
                    f"(может занять минуту-две — внутри Hawkes-MLE на каждый бар)...")
        _set_progress(progress, ticker, f"скан сигналов ({len(candles)} свечей)")
        s = strategy_settings.settings
        long_take = Decimal(s.get("LONG_TAKE", "1.015"))
        long_stop = Decimal(s.get("LONG_STOP", "0.985"))

        # OI-провайдеры (INST_OI / RETAIL_CONTRA / DELTA_QUADRANT / OI_ABSORPTION /
        # OI_SQUEEZE) из исторического FutOI (data/oi_daily.json, см. backfill_oi.py).
        # Раньше основной прогон их НЕ подключал (в отличие от save-истории и
        # trade-chart) — методы ОИ молчали (score=0) и не попадали ни в сделки,
        # ни в атрибуцию. Теперь так же, как в _save_backtest_history_one.
        from oi_layers import OiBacktestProvider
        oi_prov = OiBacktestProvider.load()
        oi_hook = None
        if oi_prov.has_data(ticker):
            strategy.set_inst_oi_provider(oi_prov.inst_oi_score)
            strategy.set_retail_contra_provider(oi_prov.retail_contra_score)
            strategy.set_delta_quadrant_provider(oi_prov.delta_quadrant_score)
            strategy.set_oi_absorption_provider(oi_prov.absorption_score)
            strategy.set_squeeze_provider(oi_prov.squeeze_score)
            strategy.set_oi_regime_provider(oi_prov.oi_instability_score)
            oi_hook = oi_prov.set_date

        # INDEX_CONTEXT: положение IMOEX к своим дневным уровням, по датам,
        # без подглядывания (bias дня D — по дневкам до D). Один date-hook
        # двигает и OI-провайдер, и индексный.
        idx_prov = _index_context_provider_for_backtest(days, offset_days)
        if idx_prov is not None and hasattr(strategy, "set_index_context_provider"):
            strategy.set_index_context_provider(idx_prov.score)
            if oi_hook is None:
                oi_hook = idx_prov.set_date
            else:
                _oi_hook0 = oi_hook
                def oi_hook(d, _h0=_oi_hook0, _p=idx_prov):
                    _h0(d)
                    _p.set_date(d)

        t1 = time.monotonic()
        signals = strategy.backtest_scan_signals(candles, adaptive_narrative=adaptive_narrative,
                                                   block_ranging=block_ranging, oi_date_hook=oi_hook)
        rej = dict(strategy.rejection_stats)
        logger.info(f"{ticker}: {len(signals)} сигналов, скан занял {time.monotonic() - t1:.1f}с"
                    + (" (адаптивная калибровка narrative)" if adaptive_narrative else "")
                    + f" | отклонений: порог={rej['below_threshold']} методы={rej['methods_disagree']} M3_veto={rej.get('gate_m3_veto', 0)} объём={rej['liquidity']}")

        # Холодный старт весов перед обучающим проходом: Hedge-обучение живёт в
        # backtest_barriers (не в scan), и без сброса оно стартовало бы от живых
        # весов из oi_weights.json — снапшот был бы смесью live+прогон, а не
        # «обученным за прогон». Сигналы уже собраны сканом — на входы сброс
        # не влияет, только на эволюцию весов и отчётные hedge_weight.
        if hasattr(strategy, "reset_weights_cold"):
            strategy.reset_weights_cold()
        fixed = strategy.backtest_barriers(signals=signals, take_mult=long_take, stop_mult=long_stop,
                                            return_trades=True, tariff=tariff, adaptive_lasso=adaptive_lasso)
        # Снимаем обученные веса СРАЗУ после первого (fixed) прохода — дальше
        # walk-forward ATR-подбор гоняет barriers ещё десятки раз по тем же
        # сигналам и дообучал бы веса повторно на пересекающихся сделках.
        trained_weights = strategy.weights_snapshot() if hasattr(strategy, "weights_snapshot") else None
        fixed_trades = fixed.pop("trades", [])
        _ticker_full_trades = fixed_trades  # вернём как третий элемент tuple
        fixed_pct = fixed.get("expectancy_pct", 0.0)
        rows.append({"ticker": ticker, "mode": "fixed", "what_if": _what_if_from_trades(fixed_trades),
                     "rejection_stats": rej,
                     # Покрытие истории OI — чтобы в UI было видно: методы ОИ
                     # используются (has=true) или молчат из-за отсутствия данных.
                     "oi_cov": oi_prov.coverage(ticker),
                     "method_stats": _merge_strategy_method_meta(
                         _method_stats_from_trades(fixed_trades), fixed.get("method_stats")),
                     "method_stats_by_regime": _method_stats_by_regime_from_trades(fixed_trades),
                     "trades_list": _trades_list_compact(fixed_trades),
                     # Обученные за прогон веса методов (холодный старт → эволюция
                     # в backtest_barriers) — для просмотра/снимка/применения к боту.
                     "method_weights": trained_weights,
                     **fixed})

        # Walk-forward, не full-history sweep: подбор лучшей (tk, sk) по сигналам
        # ДО текущего дня, торговля день — той же парой, что увидел бы живой
        # бот (см. _portfolio_sim_one_ticker mode="atr"). Раньше пара выбиралась
        # одним sweep'ом по всей истории сразу — подгонка под прошлое, отсюда
        # нереалистичные комбинации и заметно худший винрейт вживую.
        if signals:
            by_day: dict = defaultdict(list)
            for sig in signals:
                et = sig["entry_time"]
                day = et.date() if hasattr(et, "date") else str(et)[:10]
                by_day[day].append(sig)

            scale_exps = atr_scale_exps if atr_scale_exps else list(AUTO_ATR_SCALE_EXPS)
            chosen_k = (atr_take_ks[len(atr_take_ks) // 2], atr_stop_ks[len(atr_stop_ks) // 2],
                        scale_exps[len(scale_exps) // 2])
            past_signals: list[dict] = []
            wf_trades: list[dict] = []
            wf_results: list[dict] = []
            new_since_reopt = 0
            for day in sorted(by_day.keys()):
                day_signals = by_day[day]
                new_since_reopt += len(day_signals)
                if len(past_signals) >= AUTO_ATR_MIN_TRADES and new_since_reopt >= ATR_REOPT_MIN_NEW_TRADES:
                    new_since_reopt = 0
                    # Fit/eval split той же болезни, что в __recalc_auto_atr:
                    # sweep и его же оценка по одному и тому же past_signals
                    # тянет к узким стопам, которые в этом конкретном прошлом
                    # окне просто случайно не выбило шумом. Оцениваем sweep на
                    # более позднем хвосте past_signals, не участвовавшем в
                    # отборе кандидатов.
                    # Rolling lookback: берём только последние ATR_EVAL_LOOKBACK сигналов,
                    # чтобы старые режимные данные не тянули параметры в прошлое.
                    lookback_signals = past_signals[-ATR_EVAL_LOOKBACK:]
                    split = int(len(lookback_signals) * 0.6)
                    eval_signals = lookback_signals[split:] if len(lookback_signals) - split >= AUTO_ATR_MIN_TRADES else lookback_signals
                    best = None
                    for tk in atr_take_ks:
                        for sk in atr_stop_ks:
                            for ex in scale_exps:
                                r = strategy.backtest_barriers(signals=eval_signals, atr_take_k=tk, atr_stop_k=sk,
                                                                atr_scale_exp=ex, tariff=tariff, record_history=False,
                                                                return_trades=True)
                                cand_trades = r.get("trades", [])
                                if len(cand_trades) < AUTO_ATR_MIN_TRADES:
                                    continue
                                score, sem = _shrunk_score(cand_trades, fixed_pct)
                                if best is None or score > best[1]:
                                    best = ((tk, sk, ex), score, sem)
                    # Менять параметры только если ATR-кандидат превосходит
                    # fixed-бейзлайн больше чем на свой SEM — иначе "победа"
                    # на eval-окне неотличима от шума (optimizer's curse),
                    # и переключение лишь добавляет нестабильности без edge.
                    if best is not None and best[1] - ATR_MIN_EDGE_SEM * best[2] > fixed_pct:
                        chosen_k = best[0]
                tk, sk, ex = chosen_k
                res = strategy.backtest_barriers(signals=day_signals, atr_take_k=tk, atr_stop_k=sk,
                                                  atr_scale_exp=ex, return_trades=True, tariff=tariff)
                wf_results.append(res)
                wf_trades.extend(res.get("trades", []))
                past_signals.extend(day_signals)

            n_total = sum(r["n_trades"] for r in wf_results)
            if n_total:
                wf_row = {
                    "n_trades": n_total,
                    "win_rate": sum(1 for t in wf_trades if t["win"]) / n_total,
                    "avg_r": sum(t["r_multiple"] for t in wf_trades) / n_total,
                    "expectancy_pct": sum(t["net_pct"] for t in wf_trades) / n_total,
                    "model_stats": _model_stats_from_trades(wf_trades),
                    "method_stats": _merge_strategy_method_meta(
                        _method_stats_from_trades(wf_trades),
                        (wf_results[-1].get("method_stats") if wf_results else None)),
                    "method_stats_by_regime": _method_stats_by_regime_from_trades(wf_trades),
                }
                rows.append({"ticker": ticker, "mode": "ATR walk-forward",
                             "what_if": _what_if_from_trades(wf_trades),
                             "rejection_stats": rej,
                             "trades_list": _trades_list_compact(wf_trades), **wf_row})

    except Exception:
        tb = traceback.format_exc()
        context = (f"dashboard run_backtest: ticker={ticker}, days={days}, "
                   f"atr_take={atr_take_ks}, atr_stop={atr_stop_ks}")
        advice = bug_council.analyze_bug(tb, context)
        logger.error(f"run_backtest {ticker}:\n{tb}")
        rows.append({"ticker": ticker, "mode": "ошибка", "error": tb.strip().splitlines()[-1],
                     "traceback": tb, "advice": advice})
        _set_progress(progress, ticker, "ошибка")
        return rows, None, {}

    _set_progress(progress, ticker, "готово")
    # .get(ticker, {}) а не None: если у тикера слишком мало свечей для скана
    # (ничего не записалось в bt_store), это всё равно ЗАВЕРШЁННЫЙ прогон без
    # данных — а не "не пытались". {} != None дальше отличает это от реально
    # отсутствующего кэша (см. save_cached_backtest_history) — иначе такие
    # тикеры заново и заново уходили в пересчёт при каждом "сохранить историю".
    return rows, bt_store._data.get(ticker, {}), {ticker: _ticker_full_trades}


def run_backtest(
        tickers: list[str], days: int, atr_take_ks: list[float], atr_stop_ks: list[float],
        tariff: str | None = None, offset_days: int = 0,
) -> tuple[list[dict], dict[str, dict]]:
    """
    Прогоняет бэктест по всем тикерам сразу (используется как fallback API).
    Каждый тикер — это независимый дорогой CPU-bound скан (Hawkes-MLE на
    каждый бар), поэтому гоняем по процессам параллельно, а не по очереди.
    Возвращает (rows, hist_by_ticker) — hist_by_ticker нужен, чтобы "сохранить
    историю" могла использовать уже посчитанные данные без повторного прогона.
    """
    _cancel_event.clear()
    progress = _get_progress_proxy()
    for ticker in tickers:
        _set_progress(progress, ticker, "в очереди")

    ensure_oi_synced(tickers, days=days, offset_days=offset_days)  # свежий ОИ (воркер + прямой MOEX по коду) до прогонов

    if len(tickers) <= 1:
        rows: list[dict] = []
        hist_by_ticker: dict[str, dict] = {}
        for ticker in tickers:
            if _cancel_event.is_set():
                break
            r_rows, r_hist, r_trades = run_backtest_one(ticker, days, atr_take_ks, atr_stop_ks, tariff=tariff, progress=progress, offset_days=offset_days)
            rows.extend(r_rows)
            if r_hist is not None:
                hist_by_ticker[ticker] = r_hist
            with _last_full_trades_lock:
                _last_full_trades.update(r_trades)
        if _cancel_event.is_set():
            _mark_unfinished_cancelled(progress, tickers)
        return rows, hist_by_ticker

    by_ticker_rows: dict[str, list[dict]] = {}
    hist_by_ticker: dict[str, dict] = {}
    pool = ProcessPoolExecutor(max_workers=min(BACKTEST_WORKERS, len(tickers)))
    _register_pool(pool)
    try:
        futures = {
            pool.submit(run_backtest_one, ticker, days, atr_take_ks, atr_stop_ks, tariff=tariff, progress=progress, offset_days=offset_days): ticker
            for ticker in tickers
        }
        for fut in as_completed(futures):
            if _cancel_event.is_set():
                break
            ticker = futures[fut]
            try:
                r_rows, r_hist, r_trades = fut.result()
                by_ticker_rows[ticker] = r_rows
                if r_hist is not None:
                    hist_by_ticker[ticker] = r_hist
                with _last_full_trades_lock:
                    _last_full_trades.update(r_trades)
            except Exception:
                pass  # воркер мог быть убит через /api/cancel — это ожидаемо
    finally:
        _unregister_pool(pool)
        pool.shutdown(wait=True, cancel_futures=True)

    if _cancel_event.is_set():
        _mark_unfinished_cancelled(progress, tickers)

    rows = []
    for ticker in tickers:
        rows.extend(by_ticker_rows.get(ticker, []))
    return rows, hist_by_ticker


def _portfolio_sim_one_ticker(
        ticker: str, days: int, tariff: str | None,
        mode: str, atr_take_ks: list[float] | None, atr_stop_ks: list[float] | None,
        atr_scale_exps: list[float] | None = None, progress: dict | None = None,
) -> tuple[list[dict], dict | None]:
    """Считает сделки одного тикера для портфельной симуляции. Выделено в
    отдельную функцию, чтобы гонять тикеры параллельно по процессам
    (см. run_portfolio_sim) — каждый скан CPU-bound сам по себе."""
    if progress is None:
        progress = _get_progress_proxy()
    by_ticker = _all_settings_by_ticker()
    strategy_settings = by_ticker.get(ticker)
    if strategy_settings is None:
        _set_progress(progress, ticker, "ошибка")
        return [], {"ticker": ticker, "error": "нет в settings.ini и не импортирован из OI"}
    _set_progress(progress, ticker, "загрузка свечей")
    try:
        strategy = StrategyFactory.new_factory(strategy_settings.name, strategy_settings)
        _wire_history(strategy)
        if strategy is None or not hasattr(strategy, "backtest_barriers"):
            _set_progress(progress, ticker, "пропуск")
            return [], None

        try:
            candles = get_candles_cached(ticker, strategy_settings.figi, days, _market_data, _db,
                                         candle_interval_min=strategy_settings.candle_interval_min)
        except RequestError as ex:
            _set_progress(progress, ticker, "ошибка API")
            return [], {"ticker": ticker, "error": str(ex.details)}
        if not candles:
            _set_progress(progress, ticker, "нет истории")
            return [], None

        # OI-провайдеры из исторического FutOI — как в run_backtest_one/save-пути,
        # чтобы портфельная симуляция считала те же сделки, что увидел бы бот.
        from oi_layers import OiBacktestProvider
        oi_prov = OiBacktestProvider.load()
        oi_hook = None
        if oi_prov.has_data(ticker):
            strategy.set_inst_oi_provider(oi_prov.inst_oi_score)
            strategy.set_retail_contra_provider(oi_prov.retail_contra_score)
            strategy.set_delta_quadrant_provider(oi_prov.delta_quadrant_score)
            strategy.set_oi_absorption_provider(oi_prov.absorption_score)
            strategy.set_squeeze_provider(oi_prov.squeeze_score)
            strategy.set_oi_regime_provider(oi_prov.oi_instability_score)
            oi_hook = oi_prov.set_date

        idx_prov = _index_context_provider_for_backtest(days)
        if idx_prov is not None and hasattr(strategy, "set_index_context_provider"):
            strategy.set_index_context_provider(idx_prov.score)
            if oi_hook is None:
                oi_hook = idx_prov.set_date
            else:
                _oi_hook0 = oi_hook
                def oi_hook(d, _h0=_oi_hook0, _p=idx_prov):
                    _h0(d)
                    _p.set_date(d)

        _set_progress(progress, ticker, f"скан сигналов ({len(candles)} свечей)")
        signals = strategy.backtest_scan_signals(candles, oi_date_hook=oi_hook)
        trades: list[dict] = []

        if mode == "atr":
            if not signals:
                _set_progress(progress, ticker, "готово")
                return [], None
            # Раньше тут был один sweep по ВСЕЙ истории тикера — лучшая по
            # expectancy_pct пара (tk, sk) подбиралась по тем же сделкам,
            # что потом шли в отчёт (look-ahead/переподгонка). Здесь —
            # пересчёт раз в день только по сигналам ДО этого дня, как в
            # проде (см. __recalc_auto_atr): честная имитация того, что
            # увидел бы живой бот, без подглядывания в свои будущие сделки.
            grid_take = list(atr_take_ks or AUTO_ATR_TAKE_KS)
            grid_stop = list(atr_stop_ks or AUTO_ATR_STOP_KS)
            grid_exp = list(atr_scale_exps or AUTO_ATR_SCALE_EXPS)
            by_day: dict = defaultdict(list)
            for sig in signals:
                et = sig["entry_time"]
                day = et.date() if hasattr(et, "date") else str(et)[:10]
                by_day[day].append(sig)

            chosen_k = (grid_take[len(grid_take) // 2], grid_stop[len(grid_stop) // 2], grid_exp[len(grid_exp) // 2])
            past_signals: list[dict] = []
            for day in sorted(by_day.keys()):
                day_signals = by_day[day]
                if len(past_signals) >= AUTO_ATR_MIN_TRADES:
                    best = None
                    for tk in grid_take:
                        for sk in grid_stop:
                            for ex in grid_exp:
                                r = strategy.backtest_barriers(signals=past_signals, atr_take_k=tk, atr_stop_k=sk,
                                                                atr_scale_exp=ex, tariff=tariff)
                                if r["n_trades"] < AUTO_ATR_MIN_TRADES:
                                    continue
                                if best is None or r["expectancy_pct"] > best[1]:
                                    best = ((tk, sk, ex), r["expectancy_pct"])
                    if best is not None:
                        chosen_k = best[0]
                tk, sk, ex = chosen_k
                res = strategy.backtest_barriers(signals=day_signals, atr_take_k=tk, atr_stop_k=sk,
                                                  atr_scale_exp=ex, return_trades=True, tariff=tariff)
                for t in res.get("trades", []):
                    t["ticker"] = ticker
                    t["atr_k"] = f"{tk}/{sk}/{ex}"
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

        _set_progress(progress, ticker, "готово")
        return trades, None

    except Exception:
        tb = traceback.format_exc()
        advice = bug_council.analyze_bug(tb, f"dashboard run_portfolio_sim: ticker={ticker}, days={days}")
        logger.error(f"run_portfolio_sim {ticker}:\n{tb}")
        _set_progress(progress, ticker, "ошибка")
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

    _cancel_event.clear()
    progress = _get_progress_proxy()
    for ticker in tickers:
        _set_progress(progress, ticker, "в очереди")

    ensure_oi_synced(tickers, days=days)  # свежий ОИ (воркер + прямой MOEX по коду) до прогонов

    if len(tickers) <= 1:
        results = []
        for t in tickers:
            if _cancel_event.is_set():
                break
            results.append((t, _portfolio_sim_one_ticker(t, days, tariff, mode, atr_take_ks, atr_stop_ks, progress=progress)))
    else:
        results = []
        pool = ProcessPoolExecutor(max_workers=min(BACKTEST_WORKERS, len(tickers)))
        _register_pool(pool)
        try:
            futures = {
                pool.submit(_portfolio_sim_one_ticker, ticker, days, tariff, mode, atr_take_ks, atr_stop_ks,
                            progress=progress): ticker
                for ticker in tickers
            }
            for fut in as_completed(futures):
                if _cancel_event.is_set():
                    break
                try:
                    results.append((futures[fut], fut.result()))
                except Exception:
                    pass  # воркер мог быть убит через /api/cancel — это ожидаемо
        finally:
            _unregister_pool(pool)
            pool.shutdown(wait=True, cancel_futures=True)

    if _cancel_event.is_set():
        _mark_unfinished_cancelled(progress, tickers)

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
            "entry_price": t.get("entry_price"), "exit_price": t.get("exit_price"),
            "take_price": t.get("take_price"), "stop_price": t.get("stop_price"),
            "duration_min": t.get("duration_min"),
            "exit_reason": t.get("exit_reason"), "entry_mode": t.get("entry_mode", "fixed"),
            "pattern": t.get("pattern"), "regime": t.get("regime"),
            "agree_count": t.get("agree_count"), "against_count": t.get("against_count"),
            "top_agree": t.get("top_agree", []), "top_against": t.get("top_against", []),
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


def compute_equity_analytics(trade_rows: list[dict], account: float) -> dict:
    """
    Дополнительная аналитика поверх trade_rows из run_portfolio_sim:
    - daily_equity: [{date, equity}] — капитал на конец каждого дня
    - weekly_stats: [{week, n, wins, pnl_rub, win_rate}]
    - rolling_winrate: [{trade_n, win_rate}] — скользящий WR по окну 20 сделок
    - learning_curve: [{trade_n, date, cum_wr, equity}] — растёт ли WR со временем
    - model_disagree: [[дата, win, m1>0, m2>0, m3>0]] — сделки где модель НЕ согласилась
    """
    from datetime import datetime as _dt, timedelta as _td

    if not trade_rows:
        return {"daily_equity": [], "weekly_stats": [], "rolling_winrate": [],
                "learning_curve": [], "model_disagree_rate": {}}

    # daily equity
    daily: dict[str, float] = {}
    for t in trade_rows:
        day = str(t["entry_time"])[:10]
        daily[day] = t["equity_after"]
    # заполняем пропущенные дни (выходные/нет сделок) предыдущим значением
    filled_equity = []
    prev_eq = account
    all_days = sorted(daily.keys())
    if all_days:
        d = _dt.fromisoformat(all_days[0])
        end = _dt.fromisoformat(all_days[-1])
        while d <= end:
            dk = d.strftime("%Y-%m-%d")
            if dk in daily:
                prev_eq = daily[dk]
            filled_equity.append({"date": dk, "equity": prev_eq})
            d += _td(days=1)
    daily_equity = filled_equity

    # weekly stats
    weekly: dict = defaultdict(lambda: {"n": 0, "wins": 0, "pnl_rub": 0.0})
    for t in trade_rows:
        dt_str = str(t["entry_time"])[:19]
        try:
            dt = _dt.fromisoformat(dt_str)
        except Exception:
            continue
        iso = dt.isocalendar()
        week_key = f"{iso[0]}-W{iso[1]:02d}"
        w = weekly[week_key]
        w["n"] += 1
        w["wins"] += 1 if t["r_multiple"] > 0 else 0
        w["pnl_rub"] += t["pnl_rub"]
    weekly_stats = [
        {"week": k, "n": v["n"], "wins": v["wins"],
         "win_rate": round(v["wins"] / v["n"], 3) if v["n"] else 0,
         "pnl_rub": round(v["pnl_rub"], 2)}
        for k, v in sorted(weekly.items())
    ]

    # rolling winrate (окно 20 сделок)
    WINDOW = 20
    results_bin = [1 if t["r_multiple"] > 0 else 0 for t in trade_rows]
    rolling_winrate = []
    for i, t in enumerate(trade_rows):
        start = max(0, i - WINDOW + 1)
        n_w = i - start + 1
        wr = sum(results_bin[start:i + 1]) / n_w
        rolling_winrate.append({"trade_n": i + 1, "date": str(t["entry_time"])[:10],
                                 "win_rate": round(wr, 3), "equity": t["equity_after"]})

    # learning curve — то же, что rolling, но и накопленный WR (растёт ли модель)
    cum_w = 0
    learning_curve = []
    for i, t in enumerate(trade_rows):
        cum_w += results_bin[i]
        learning_curve.append({
            "trade_n": i + 1,
            "date": str(t["entry_time"])[:10],
            "cum_wr": round(cum_w / (i + 1), 3),
            "rolling_wr": rolling_winrate[i]["win_rate"],
            "equity": t["equity_after"],
        })

    # M1/M2/M3 disagree rate — доля сделок где модель не согласилась с направлением
    model_disagree_rate = {}
    for m in ("m1", "m2", "m3"):
        total, disagree = 0, 0
        for t in trade_rows:
            sc = t.get(m, 0.0)
            if sc == 0:
                continue
            total += 1
            if (sc > 0) != (t["r_multiple"] > 0 or t.get("direction") == "LONG"):
                disagree += 1
        if total:
            model_disagree_rate[m.upper() + "_CLUSTER"] = {
                "total": total, "disagree": disagree,
                "rate": round(disagree / total, 3),
            }

    # Агрегация по отдельным методам стратегии: для каждого метода —
    # agree_n/agree_wr/disagree_n/disagree_wr — видно какой метод реально полезен
    method_stats: dict[str, dict] = {}
    SCORE_THRESH = 0.05  # метод считается активным если |score| > порога
    for t in trade_rows:
        ms = t.get("method_scores") or {}
        dir_sign = 1 if t.get("direction") == "LONG" else -1
        win = 1 if t["r_multiple"] > 0 else 0
        for method, sc in ms.items():
            if abs(sc) < SCORE_THRESH:
                continue
            if method not in method_stats:
                method_stats[method] = {"agree_n": 0, "agree_win": 0,
                                        "disagree_n": 0, "disagree_win": 0}
            s = method_stats[method]
            if (sc > 0) == (dir_sign > 0):
                s["agree_n"] += 1
                s["agree_win"] += win
            else:
                s["disagree_n"] += 1
                s["disagree_win"] += win

    method_stats_out = {}
    for name, s in method_stats.items():
        method_stats_out[name] = {
            "agree_n": s["agree_n"],
            "agree_wr": round(s["agree_win"] / s["agree_n"], 3) if s["agree_n"] else None,
            "disagree_n": s["disagree_n"],
            "disagree_wr": round(s["disagree_win"] / s["disagree_n"], 3) if s["disagree_n"] else None,
        }

    return {
        "daily_equity": daily_equity,
        "weekly_stats": weekly_stats,
        "rolling_winrate": rolling_winrate,
        "learning_curve": learning_curve,
        "model_disagree_rate": model_disagree_rate,
        "method_stats": method_stats_out,
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
.hdr{{display:flex;align-items:center;gap:16px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border2);flex-wrap:wrap;}}
.logo{{font-family:'Unbounded',sans-serif;font-size:13px;font-weight:700;color:var(--accent);text-shadow:0 0 20px rgba(255,0,110,0.35);white-space:nowrap;}}
.logo-sub{{font-size:9px;color:var(--txt3);letter-spacing:.08em;margin-top:2px;}}
/* ── Вкладки ── */
.tab-nav{{display:flex;gap:6px;flex-wrap:wrap;}}
.tab-btn{{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);border-radius:999px;color:var(--txt3);font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;letter-spacing:.06em;padding:7px 18px;cursor:pointer;transition:all .18s;}}
.tab-btn:hover{{border-color:rgba(255,0,128,.3);color:var(--txt2);}}
.tab-btn.active{{background:linear-gradient(180deg,rgba(255,0,128,.22),rgba(255,0,128,.10));border-color:rgba(255,0,128,.55);color:var(--accent);box-shadow:0 0 12px rgba(255,0,128,.15);}}
.tab-pane{{display:none;}}.tab-pane.active{{display:block;}}
/* ── Раскладка: сайдбар тикеров + основная колонка ── */
.app-layout{{display:flex;gap:14px;align-items:flex-start;}}
.sidebar{{flex:0 0 300px;width:300px;position:sticky;top:14px;max-height:calc(100vh - 28px);overflow-y:auto;background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:14px;scrollbar-width:thin;scrollbar-color:var(--border2) transparent;transition:flex-basis .18s,width .18s,opacity .12s,padding .18s;}}
.sidebar::-webkit-scrollbar{{width:6px;}}
.sidebar::-webkit-scrollbar-thumb{{background:var(--border2);border-radius:3px;}}
.sidebar.collapsed{{flex:0 0 0;width:0;padding:14px 0;opacity:0;overflow:hidden;border-color:transparent;}}
.sidebar-head{{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;}}
.sidebar-collapse-btn{{flex:0 0 auto;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);border-radius:999px;color:var(--txt3);font-size:13px;line-height:1;width:24px;height:24px;cursor:pointer;}}
.sidebar-collapse-btn:hover{{border-color:rgba(255,0,128,.3);color:var(--txt2);}}
.main-col{{flex:1;min-width:0;}}
.sidebar-open-btn{{display:none;}}
.sidebar-open-btn.show{{display:inline-flex;}}
/* ── Панели ── */
.panel{{background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:16px;margin-bottom:14px;}}
.panel-inner{{background:var(--card);border:1px solid var(--border2);border-radius:14px;padding:12px 14px;margin-bottom:10px;}}
.sec{{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--txt3);margin-bottom:10px;}}
.sec-lg{{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--txt2);margin-bottom:12px;border-bottom:1px solid var(--border2);padding-bottom:8px;}}
label{{display:inline-block;margin:4px 12px 4px 0;font-size:11px;color:var(--txt2);}}
.inp{{background:var(--panel);border:1px solid var(--border);border-radius:999px;padding:6px 14px;color:var(--txt2);font-family:'JetBrains Mono',monospace;font-size:11px;outline:none;}}
.inp:focus{{border-color:rgba(255,0,110,.4);}}
.inp.mid{{width:100px;}}
.btn-pill{{background:linear-gradient(180deg,rgba(255,0,128,.22),rgba(255,0,128,.12));border:1px solid rgba(255,0,128,.5);border-radius:999px;color:var(--accent);font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;letter-spacing:.06em;padding:8px 18px;cursor:pointer;transition:all .15s;}}
.btn-pill:hover{{box-shadow:0 0 14px rgba(255,0,128,.25);}}
.btn-sm{{padding:4px 12px;font-size:10px;}}
.btn-xs{{padding:3px 10px;font-size:10px;}}
/* ── Варианты кнопок: цвет = смысл действия, не случайность.
   primary (розовый, дефолт) — главное действие панели.
   danger — стоп/закрыть/остановить. ghost — нейтральная утилита.
   info — информационное/копировать. ok — сохранить/положительное.
   toggled — активный режим переключателя (тумблер). ── */
.btn-pill.danger{{background:linear-gradient(180deg,rgba(255,60,60,.32),rgba(255,60,60,.16));border-color:rgba(255,60,60,.55);color:#ffb3b3;}}
.btn-pill.danger:hover{{box-shadow:0 0 14px rgba(255,60,60,.3);}}
.btn-pill.ghost{{background:rgba(255,255,255,.03);border-color:rgba(255,255,255,.12);color:var(--txt2);}}
.btn-pill.ghost:hover{{box-shadow:none;border-color:rgba(255,255,255,.22);}}
.btn-pill.info{{background:linear-gradient(180deg,rgba(80,140,255,.2),rgba(80,140,255,.1));border-color:rgba(80,140,255,.45);color:#7eb8f7;}}
.btn-pill.info:hover{{box-shadow:0 0 14px rgba(80,140,255,.25);}}
.btn-pill.ok{{background:linear-gradient(180deg,rgba(82,242,201,.2),rgba(82,242,201,.1));border-color:rgba(82,242,201,.45);color:#9fe8ce;}}
.btn-pill.ok:hover{{box-shadow:0 0 14px rgba(82,242,201,.25);}}
.btn-pill.toggled{{background:linear-gradient(180deg,rgba(124,77,255,.4),rgba(124,77,255,.22));border-color:rgba(124,77,255,.65);color:#fff;}}
.chips{{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px;}}
.chip{{display:inline-flex;align-items:center;height:24px;padding:0 12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:999px;cursor:pointer;transition:all .15s;font-size:11px;font-weight:600;line-height:1;color:var(--txt);white-space:nowrap;}}
.chip:hover{{border-color:rgba(255,0,128,.25);}}
.chip.active{{background:linear-gradient(180deg,rgba(255,0,128,.18),rgba(255,0,128,.08));border-color:rgba(255,0,128,.45);color:var(--accent);}}
.chip-fut{{border-color:rgba(80,140,255,.25);}}
.chip-fut.active{{background:linear-gradient(180deg,rgba(80,140,255,.2),rgba(80,140,255,.08));border-color:rgba(80,140,255,.6);color:#7eb8f7;}}
.chip-fut:hover{{border-color:rgba(80,140,255,.5);}}
.chip-row{{display:flex;flex-wrap:wrap;gap:4px;align-content:flex-start;}}
/* ── Тулбар тикеров (сайдбар): один размер кнопки, одна нейтральная цветовая
   тема — цвет несут только эмодзи-иконки, не текст. ── */
.tk-toolbar{{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px;}}
.tk-btn{{display:inline-flex;align-items:center;height:26px;padding:0 11px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);border-radius:8px;color:var(--txt2);font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;line-height:1;cursor:pointer;transition:all .15s;white-space:nowrap;}}
.tk-btn:hover{{border-color:rgba(255,0,128,.3);color:var(--txt);}}
.tk-btn-note{{font-size:11px;color:var(--txt3);}}
/* ── Категории тикеров — вертикальный аккордеон, раскрывается вниз ── */
.chip-group{{margin-bottom:8px;border:1px solid var(--border2);border-radius:10px;overflow:hidden;}}
.chip-group>summary{{list-style:none;cursor:pointer;height:32px;padding:0 12px;font-size:12px;font-weight:700;letter-spacing:.04em;color:var(--txt);background:rgba(255,255,255,.035);display:flex;align-items:center;gap:8px;}}
.chip-group>summary::-webkit-details-marker{{display:none;}}
.chip-group>summary::before{{content:'▾';display:inline-flex;align-items:center;justify-content:center;width:10px;flex:0 0 10px;color:var(--txt2);font-size:10px;line-height:1;transition:transform .15s;}}
.chip-group:not([open])>summary::before{{transform:rotate(-90deg);}}
.chip-group-body{{padding:8px;display:flex;flex-direction:column;gap:4px;}}
.chip-section{{margin-bottom:0;border:1px solid var(--border2);border-radius:8px;overflow:hidden;}}
.chip-section>summary{{list-style:none;cursor:pointer;height:30px;padding:0 12px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--txt2);background:rgba(255,255,255,.02);display:flex;align-items:center;gap:8px;}}
.chip-section>summary::-webkit-details-marker{{display:none;}}
.chip-section>summary::before{{content:'▸';display:inline-flex;align-items:center;justify-content:center;width:10px;flex:0 0 10px;color:var(--txt3);font-size:10px;line-height:1;transition:transform .15s;}}
.chip-section[open]>summary::before{{transform:rotate(90deg);}}
.chip-section>summary:hover{{background:rgba(255,255,255,.05);}}
.chip-section-title{{flex:1;overflow:hidden;text-overflow:ellipsis;}}
.chip-section>.chip-row{{padding:8px 12px 10px;}}
.cat-toc-toggle{{flex:0 0 16px;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(255,255,255,.05);color:var(--txt3);font-size:11px;line-height:1;cursor:pointer;}}
/* ── Группы настроек — сетка карточек вместо ленты ярлыков подряд ── */
.cfg-grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px;margin-top:6px;}}
.cfg-group{{background:var(--card);border:1px solid var(--border2);border-radius:12px;padding:10px 12px;}}
.cfg-group-title{{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--txt3);margin-bottom:8px;}}
.cfg-group label{{display:flex;align-items:center;gap:6px;margin:0 0 8px 0;font-size:11px;color:var(--txt2);}}
.cfg-group label:last-child{{margin-bottom:0;}}
.cfg-group label.cfg-check{{cursor:help;}}
.cfg-group .inp{{flex:0 0 auto;max-width:100%;}}
.cfg-group select.inp{{min-width:0;width:100%;overflow:hidden;text-overflow:ellipsis;}}
.cfg-group label:has(select.inp){{flex-wrap:wrap;}}
input[type="checkbox"]{{accent-color:var(--accent);}}
input[type="number"]{{background:var(--panel);border:1px solid var(--border);border-radius:8px;color:var(--txt);padding:4px 8px;font-family:'JetBrains Mono',monospace;font-size:11px;outline:none;-moz-appearance:textfield;}}
input[type="number"]::-webkit-inner-spin-button,input[type="number"]::-webkit-outer-spin-button{{filter:invert(1) brightness(0.4);opacity:.6;}}
input[type="range"]{{-webkit-appearance:none;appearance:none;height:4px;border-radius:4px;background:rgba(255,255,255,.12);outline:none;cursor:pointer;}}
input[type="range"]::-webkit-slider-thumb{{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:var(--accent);border:2px solid rgba(255,255,255,.2);cursor:pointer;}}
input[type="range"]::-moz-range-thumb{{width:14px;height:14px;border-radius:50%;background:var(--accent);border:2px solid rgba(255,255,255,.2);cursor:pointer;}}
input[type="range"]::-webkit-slider-runnable-track{{border-radius:4px;}}
select{{background:var(--panel);border:1px solid var(--border);border-radius:8px;color:var(--txt);padding:4px 8px;font-family:'JetBrains Mono',monospace;font-size:11px;outline:none;}}
.cat-toc-toggle:hover{{color:var(--accent);background:rgba(255,0,128,.12);}}
.scen-table{{width:100%;border-collapse:collapse;font-size:11px;margin-top:10px;}}
.scen-table th{{text-align:right;color:var(--txt3);font-weight:400;padding:5px 8px;border-bottom:1px solid rgba(255,255,255,.08);}}
.scen-table th:first-child,.scen-table td:first-child{{text-align:left;}}
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
  <button class="btn-pill btn-sm sidebar-open-btn" id="sidebarOpenBtn" onclick="toggleSidebar()" title="Показать список тикеров">☰ Тикеры</button>
</div>

<nav class="tab-nav">
  <button class="tab-btn active" onclick="showTab('sim')">СИМУЛЯЦИЯ</button>
  <button class="tab-btn" onclick="showTab('analytics')">АНАЛИТИКА</button>
  <button class="tab-btn" onclick="showTab('diag')">ДИАГНОСТИКА</button>
  <button class="tab-btn" onclick="showTab('barscores')">BAR SCORES</button>
  <button class="tab-btn" onclick="showTab('live')">БОТ (LIVE)</button>
</nav>

<div class="app-layout">
<aside class="sidebar" id="sidebar">
  <div class="sidebar-head">
    <div class="sec-lg" style="margin-bottom:0;border-bottom:none;padding-bottom:0;">Тикеры</div>
    <button class="sidebar-collapse-btn" onclick="toggleSidebar()" title="Свернуть">‹</button>
  </div>
  <div id="tickers">__TICKER_CHECKBOXES__</div>
</aside>
<div class="main-col">

<!-- ══════════════════════ TAB: СИМУЛЯЦИЯ ══════════════════════ -->
<div class="tab-pane active" id="tab-sim">

<div class="panel">
  <div class="sec-lg">Настройки симуляции</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:10px;">
    🔷 Фьючерсы — из [FUTURES_TRADING] (авто). ♦️ Акции — settings.ini + OI.
    Список тикеров — в сайдбаре слева (☰ в шапке — свернуть/развернуть).
  </div>
  <div class="cfg-grid">

    <div class="cfg-group">
      <div class="cfg-group-title">Период бэктеста</div>
      <label>Дней истории <input type="number" class="inp mid" id="days" value="150" min="1" max="240"></label>
      <label title="Сдвиг конца периода назад от сегодня, в днях. 0 = период кончается сегодня. Чтобы добрать более старый период без повторного прогона уже посчитанного — например, прогнала days=150 offset=0 (последние 150 дней), затем days=150 offset=150 (предыдущие 150, т.е. 150-300 дней назад).">Сдвиг начала, дн. <input type="number" class="inp mid" id="offset_days" value="0" min="0" max="2000"></label>
      <button type="button" class="btn-pill btn-xs ghost" onclick="checkHistoryCoverage()" title="Показать, какой период уже посчитан и сохранён в data/history.json по каждому тикеру — чтобы не угадывать offset_days">📅 что уже посчитано?</button>
      <span id="history_coverage_out" style="display:block;width:100%;font-size:11px;color:var(--txt3);white-space:pre-wrap;margin-top:6px;"></span>
    </div>

    <div class="cfg-group">
      <div class="cfg-group-title">Режим прогона</div>
      <label class="cfg-check" title="Прогонять активные чипы тикеров в обратном порядке (с конца списка). Удобно, если на весь список обычно не хватает терпения и не запомнила, где остановилась прошлый раз — следующий прогон зацепит другой край списка."><input type="checkbox" id="reverse_order"> С конца списка</label>
      <label class="cfg-check" title="Блокировать вход в позицию когда классификатор определяет режим рынка как боковик (ranging). По умолчанию ranging разрешён, только stress блокируется. Включи, чтобы избежать торговли в флэте — может сильно снизить число сделок."><input type="checkbox" id="block_ranging"> Не торговать в боковике (ranging)</label>
      <label class="cfg-check" title="Без дублей по эмитенту (обычка/префы, фьючерс/базис) — отбирает топ N% по востребованности."><input type="checkbox" id="dedup_issuer" checked> Без дублей по эмитенту, топ <input type="number" class="inp" style="width:46px;padding:4px 6px;" id="top_pct" value="70" min="1" max="100">%</label>
    </div>

    <div class="cfg-group">
      <div class="cfg-group-title">Адаптивная калибровка</div>
      <label class="cfg-check" title="Пороги тегов narrative (bullish/accum/climax_spread) пере-калибруются прямо в процессе скана, раз в ~20 симулированных дней, по уже накопленным внутри этого же прогона дневным method_scores — без захардкоженных дефолтов и без файла narrative_thresholds.json."><input type="checkbox" id="adaptive_narrative"> Narrative</label>
      <label class="cfg-check" title="Lasso-приоры методов пере-фитятся прямо в процессе бэктеста: сигналы и так обрабатываются в хронологическом порядке (как M1/M2/M3 cluster-models), и исход сделки (take/stop/timeout) известен сразу после неё. Каждые ~30 сделок фитим lasso на всех сделках, накопленных к этому моменту, и обновляем веса методов для последующих сделок того же прогона."><input type="checkbox" id="adaptive_lasso"> Lasso-приоры</label>
    </div>

    <div class="cfg-group">
      <div class="cfg-group-title" style="display:flex;align-items:center;gap:8px;">
        Отключить методы для прогона
        <button class="btn-pill btn-xs ghost" onclick="toggleMethodDisable()" style="font-size:10px;padding:2px 8px;">показать/скрыть</button>
        <button class="btn-pill btn-xs ghost" onclick="clearDisabledMethods()" style="font-size:10px;padding:2px 8px;">сбросить</button>
        <span id="disabled_count" style="font-size:10px;color:var(--neg);"></span>
      </div>
      <div id="method_disable_panel" style="display:none;margin-top:6px;">
        <div style="font-size:10px;color:var(--txt3);margin-bottom:6px;">Отмеченные методы будут давать 0 в голосовании (как будто не существуют). Кнопка ↔ — использовать метод как контр-индикатор (инвертировать скор). «инфо» — метод считается, но выключить его отсюда нельзя (провайдерный/структурный/диагностика).</div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
          <button class="btn-pill btn-xs ghost" onclick="saveMethodPreset()" style="font-size:10px;padding:2px 8px;" title="Сохранить текущий набор откл/инверсий под именем — переживёт перезапуск дашборда">💾 сохранить пресет</button>
          <select id="method_preset_select" onchange="applyMethodPreset()" style="font-size:10px;padding:2px 6px;background:var(--bg2);color:var(--txt2);border:1px solid var(--border2);border-radius:4px;"><option value="">— загрузить пресет —</option></select>
          <button class="btn-pill btn-xs ghost" onclick="deleteMethodPreset()" style="font-size:10px;padding:2px 8px;" title="Удалить выбранный пресет">🗑</button>
          <span id="method_preset_msg" style="font-size:10px;color:var(--txt3);"></span>
        </div>
        <div id="method_checkboxes" style="display:flex;flex-wrap:wrap;gap:4px 10px;"></div>
      </div>
    </div>

    <div class="cfg-group">
      <div class="cfg-group-title" style="display:flex;align-items:center;gap:8px;">
        Адаптивная калибровка индикаторов (по тикерам)
        <button class="btn-pill btn-xs ghost" onclick="loadMethodCalibration()" style="font-size:10px;padding:2px 8px;">показать что адаптировалось</button>
      </div>
      <div style="font-size:10px;color:var(--txt3);margin-bottom:4px;">Из method_params.json — что бот подобрал под каждый тикер на РЕАЛЬНЫХ данных (walk-forward, expectancy со стопом). edge — ожидаемая доходность на сигнал в б.п.; λ — усадка к классике; согл. — доля фолдов, где выбранный обошёл классику.</div>
      <div id="method_calib_panel" style="display:none;margin-top:4px;"></div>
    </div>

    <div class="cfg-group">
      <div class="cfg-group-title">Параметры стратегии</div>
      <label>ATR_TAKE_K <input type="text" class="inp mid" id="atr_take" value="2,3,4"></label>
      <label>ATR_STOP_K <input type="text" class="inp mid" id="atr_stop" value="1,1.5,2"></label>
      <label>Тариф комиссии <select class="inp" id="tariff">
        <option value="">как в settings.ini</option>
        <option value="TRADER">Трейдер (0.05%/0.04% за сторону)</option>
        <option value="PREMIUM">Премиум (0.04%/0.025% за сторону)</option>
      </select></label>
    </div>

    <div class="cfg-group">
      <div class="cfg-group-title">Источники данных</div>
      <input type="file" id="oiFile" accept="application/json" style="display:none" onchange="importOiFile(event)">
      <label style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn-pill btn-xs ghost" onclick="document.getElementById('oiFile').click()">↓ Импорт из OI</button>
        <button class="btn-pill btn-xs ghost" onclick="fetchMegaAlerts()">🔥 Аномалии MOEX</button>
      </label>
      <span id="oi_status" style="font-size:11px;color:var(--txt3);"></span>
    </div>

  </div>
</div>

<div class="panel">
  <div class="sec-lg">Бэктест по тикерам</div>
  <button class="btn-pill" onclick="runBacktest()">▶ ЗАПУСТИТЬ БЭКТЕСТ</button>
  <button class="btn-pill danger" onclick="cancelRun()">⏹ СТОП</button>
  <button class="btn-pill info" onclick="runSystemBacktest()" title="Системный прогон: каждый тикер через СВОЮ живую стратегию (composite/accel/NW по settings.ini), единый held-out бэктест — exp/win/N в одной таблице. Не «всегда composite», а как система реально торгует.">🧭 СИСТЕМНЫЙ ПРОГОН</button>
  <button class="btn-pill btn-sm ghost" onclick="saveBacktestHistory()" title="Сохранить сделки бэктеста в history.json для калибровки lasso">💾 сохранить историю</button>
  <button class="btn-pill btn-sm ghost" onclick="runCalibration()" title="Калибровка порогов narrative.py + lasso_calibration + rule_miner по уже сохранённой history.json">🎯 калибровать (narrative+lasso+rules)</button>
  <button class="btn-pill btn-sm ghost" onclick="calibrateAllHistory()" title="Калибровать по ВСЕМ тикерам/датам, что уже лежат в data/history.json, независимо от того, какие чипы сейчас активны на странице">🎯 калибровать по всей history.json</button>
  <button class="btn-pill btn-sm info" onclick="copyAllResults(this)" title="Скопировать все результаты включая attribution по методам">📋 копировать всё</button>
  <button class="btn-pill btn-sm ghost" onclick="showMfeStats()" title="Медианы MFE/MAE из текущего прогона — показывает структурное соотношение хода цены за/против позиции">📐 MFE/MAE</button>
  <button class="btn-pill btn-sm ghost" onclick="showRunWeights()" title="Hedge-веса методов из текущего прогона — усиленные >1 и ослабленные <1. Наведи на строку — описание метода.">⚖️ веса прогона</button>
  <button id="btnDashView" class="btn-pill btn-sm ghost" onclick="toggleDashView()" title="Переключить между видом таблицы и видом дашборда с панелями">⊞ дашборд</button>
  <button class="btn-pill btn-sm ok" onclick="calibrateMethodWeights(this)" title="Рассчитать мультипликаторы весов методов из атрибуции и сохранить в data/ticker_method_weights.json">💾 веса методов</button>
  <button id="btnResetWeights" class="btn-pill btn-sm warn" onclick="resetWeights()" title="Сбросить Hedge-веса методов в oi_weights.json до 0.30 (консервативный старт). IC-prior не затрагивается.">🔄 сброс весов</button>
  <button class="btn-pill btn-sm ghost" onclick="showTrainedWeights()" title="Обученные ЗА ПРОГОН веса методов (холодный старт → эволюция по сделкам), отсортированы по весу: сверху самые точные, снизу неточные и инвертированные (отрицательный вес)">🏋 обученные веса</button>
  <button class="btn-pill btn-sm ok" onclick="saveWeightsSnapshot()" title="Сохранить обученные веса прогона в отдельный файл (data/weights_snapshots) — боевого бота НЕ трогает">💾 снимок весов</button>
  <select id="weights_snapshot_select" onclick="refreshWeightsSnapshots()" style="font-size:11px;padding:3px 6px;background:var(--bg2);color:var(--txt2);border:1px solid var(--border2);border-radius:4px;"><option value="">— снимок весов —</option></select>
  <button class="btn-pill btn-sm warn" onclick="applyWeightsSnapshotConfirm()" title="Применить выбранный снимок к боевому oi_weights.json — с окном подтверждения. Бэкап в oi_weights.json.bak.">⚠️ применить к боту</button>
  <span id="status"></span>
  <div id="systemResult" style="margin-top:8px;"></div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px;font-size:11px;color:var(--txt3);">
    <label><input type="checkbox" id="hide_zero" onchange="renderResultsTable()"> скрыть нулевые</label>
    <label>мин сделок: <input type="number" id="min_trades" value="0" min="0" style="width:44px;background:var(--panel);border:1px solid var(--border2);color:var(--txt);border-radius:4px;padding:1px 4px;" onchange="renderResultsTable()"></label>
    <label>сортировка:
      <select id="sort_by" onchange="renderResultsTable()" style="background:var(--panel);border:1px solid var(--border2);color:var(--txt);border-radius:4px;padding:1px 4px;font-size:11px;">
        <option value="">по умолчанию</option>
        <option value="win_desc">win% ↓</option>
        <option value="win_asc">win% ↑</option>
        <option value="exp_desc">exp% ↓</option>
        <option value="exp_asc">exp% ↑</option>
        <option value="avgr_desc">avg R ↓</option>
        <option value="avgr_asc">avg R ↑</option>
        <option value="n_desc">сделок ↓</option>
        <option value="n_asc">сделок ↑</option>
      </select>
    </label>
    <label>топ N: <input type="number" id="top_n" value="" min="1" placeholder="все" style="width:44px;background:var(--panel);border:1px solid var(--border2);color:var(--txt);border-radius:4px;padding:1px 4px;" onchange="renderResultsTable()"></label>
    <label><input type="checkbox" id="top_n_worst" onchange="renderResultsTable()"> худшие</label>
  </div>
  <div id="status_detail" style="font-size:11px;color:var(--txt3);margin-top:6px;"></div>
  <div id="calib_status_detail" style="font-size:11px;color:var(--txt3);margin-top:6px;"></div>
  <table class="scen-table" id="results"></table>
  <div id="compare_block" style="display:none;margin-top:8px"></div>
  <div id="mfe_stats_out" style="display:none;margin-top:12px;"></div>
  <div id="run_weights_out" style="display:none;margin-top:12px;"></div>
  <div id="trained_weights_out" style="display:none;margin-top:12px;"></div>
  <div id="global_method_stats" style="display:none;margin-top:14px;"></div>
</div>

<div id="dash-grid" style="display:none;padding:12px 16px;">
  <div style="display:grid;grid-template-columns:260px 1fr;gap:10px;height:90vh;min-height:600px;">

    <!-- Левая колонка: список тикеров -->
    <div style="display:flex;flex-direction:column;gap:6px;min-height:0;">
      <div style="font-size:11px;color:var(--txt3);padding:0 2px;">Тикеры прогона</div>
      <div id="dg-ticker-list" style="overflow-y:auto;flex:1;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:6px 0;"></div>
      <div id="dg-summary" style="background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:8px 10px;font-size:11px;flex-shrink:0;"></div>
    </div>

    <!-- Правая часть: график вверху + 3 панели снизу -->
    <div style="display:grid;grid-template-rows:55% 45%;gap:10px;min-height:0;">

      <!-- График со сделками -->
      <div id="dg-chart-panel" style="background:var(--panel);border:1px solid var(--border);border-radius:10px;display:flex;flex-direction:column;min-height:0;overflow:hidden;">
        <div id="dg-chart-header" style="padding:6px 12px;font-size:11px;color:var(--txt3);border-bottom:1px solid var(--border);flex-shrink:0;display:flex;align-items:center;gap:10px;">
          <span id="dg-chart-title">График — выбери тикер</span>
          <span style="color:var(--txt3);font-size:10px;">колесо — масштаб · перетащи — панорама</span>
        </div>
        <div id="dg-chart-body" style="flex:1;min-height:0;padding:4px;overflow:hidden;"></div>
      </div>

      <!-- Три нижних панели -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;min-height:0;">

        <!-- Сделки -->
        <div style="background:var(--panel);border:1px solid var(--border);border-radius:10px;display:flex;flex-direction:column;min-height:0;">
          <div id="dg-trades-header" style="padding:6px 10px;font-size:11px;color:var(--txt3);border-bottom:1px solid var(--border);flex-shrink:0;">Сделки</div>
          <div id="dg-trades-body" style="overflow-y:auto;flex:1;padding:4px;font-size:10px;"></div>
        </div>

        <!-- Лучшие / худшие -->
        <div style="background:var(--panel);border:1px solid var(--border);border-radius:10px;display:flex;flex-direction:column;min-height:0;">
          <div style="padding:6px 10px;font-size:11px;color:var(--txt3);border-bottom:1px solid var(--border);flex-shrink:0;">▲▼ Лучшие / худшие</div>
          <div id="dg-bestworst-body" style="overflow-y:auto;flex:1;padding:4px;font-size:10px;"></div>
        </div>

        <!-- Методы -->
        <div style="background:var(--panel);border:1px solid var(--border);border-radius:10px;display:flex;flex-direction:column;min-height:0;">
          <div style="padding:6px 10px;font-size:11px;color:var(--txt3);border-bottom:1px solid var(--border);flex-shrink:0;">Методы</div>
          <div id="dg-methods-body" style="overflow-y:auto;flex:1;padding:4px;font-size:10px;"></div>
        </div>

      </div>
    </div>
  </div>
</div>

<div class="panel">
  <div class="sec-lg">Портфель — виртуальный счёт</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:8px;">
    Сделки выбранных тикеров (галочки выше) сводятся в одну хронологию и
    проигрываются на одном балансе, размер сделки = риск% от текущего баланса.
    Режим «ATR» — на каждом тикере берётся лучшая пара ATR_TAKE_K/ATR_STOP_K
    по expectancy из сетки выше.
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
  <button class="btn-pill danger" onclick="cancelRun()">⏹ СТОП</button>
  <span id="pf_status"></span>
  <div id="pf_status_detail" style="font-size:11px;color:var(--txt3);margin-top:6px;"></div>
  <div id="pf_summary"></div>
  <div class="sec" style="margin-top:14px;">По месяцам</div>
  <table class="scen-table" id="pf_monthly"></table>
  <div class="sec" style="margin-top:14px;">По тикерам</div>
  <table class="scen-table" id="pf_ticker"></table>
  <div class="sec" style="margin-top:14px;">Отдельные сделки</div>
  <table class="scen-table" id="pf_trades"></table>
</div>

<div class="panel">
  <div class="sec-lg">График сделок</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:8px;">
    Японские свечи + сделки из бэктеста: вход/выход, уровни тейк/стоп, направление.
    Нажми на маркер сделки — увидишь детали ниже. Полоса MFE/MAE показывает,
    какую часть хода бот взял и где был максимальный ход против позиции.
  </div>
  <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px;">
    <label>Тикер <select class="inp mid" id="tc_ticker"><option value="">— запусти бэктест —</option></select></label>
    <label>ATR_TAKE_K <input type="number" class="inp mid" id="tc_take" value="2.0" min="0.5" step="0.5"></label>
    <label>ATR_STOP_K <input type="number" class="inp mid" id="tc_stop" value="1.0" min="0.3" step="0.5"></label>
    <button class="btn-pill" onclick="loadTradeChart()">▶ ЗАГРУЗИТЬ</button>
    <button class="btn-pill ok" onclick="exportBarScores()" title="Скачать CSV со всеми method_scores по каждому бару — для AI-анализа">📥 CSV для AI</button>
    <span id="tc_status" style="font-size:11px;color:var(--txt3);"></span>
  </div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;font-size:11px;color:var(--txt3);">
    <span>🔍 колесо/пинч — масштаб &nbsp;|&nbsp; перетащи — панорама &nbsp;|&nbsp; Shift+drag — выделить область</span>
    <button class="btn-pill btn-xs ghost" onclick="tcZoomAll()">Всё</button>
    <button class="btn-pill btn-xs ghost" onclick="tcZoomLast(30)">30д</button>
    <button class="btn-pill btn-xs ghost" onclick="tcZoomLast(14)">14д</button>
    <button class="btn-pill btn-xs ghost" onclick="tcZoomLast(7)">7д</button>
    <span style="margin-left:8px;">Вид:</span>
    <button class="btn-pill btn-xs toggled" id="tc_mode_candle" onclick="tcSetMode('candle')">Свечи</button>
    <button class="btn-pill btn-xs ghost"   id="tc_mode_line"   onclick="tcSetMode('line')">Линия</button>
  </div>
  <div id="tc_canvas_wrap">
    <canvas id="tc_canvas" style="width:100%;height:480px;display:block;cursor:crosshair;background:var(--panel);border-radius:10px;border:1px solid var(--border);"></canvas>
    <div id="tc_sel_info" style="font-size:12px;color:var(--txt2);margin-top:6px;min-height:24px;padding:4px 8px;background:var(--card);border-radius:8px;border:1px solid var(--border);display:none;"></div>
    <div id="tc_tooltip" style="font-size:11px;color:var(--txt2);margin-top:4px;min-height:28px;padding:4px 8px;background:var(--card);border-radius:8px;border:1px solid var(--border);display:none;"></div>
    <div id="tc_trade_detail" style="font-size:11px;color:var(--txt2);margin-top:4px;min-height:24px;"></div>
  </div>
</div>

</div><!-- /tab-sim -->

<!-- ══════════════════════ TAB: АНАЛИТИКА ══════════════════════ -->
<div class="tab-pane" id="tab-analytics">

<div class="panel">
  <div class="sec-lg">Анализ капитала и обучения модели</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:10px;">
    Прогон бэктеста по всем выбранным тикерам → equity-кривая, rolling winrate,
    кривая обучения (растёт ли WR по мере накопления истории). Запускай на ночь.
  </div>
  <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
    <label>Дней <input type="number" class="inp mid" id="an_days" value="60" min="10" max="365"></label>
    <label>Счёт ₽ <input type="number" class="inp mid" id="an_account" value="100000" min="1000"></label>
    <label>Риск% <input type="number" class="inp mid" id="an_risk" value="1" min="0.1" max="5" step="0.1"></label>
    <button class="btn-pill" onclick="runEquityAnalysis()">▶ ЗАПУСТИТЬ АНАЛИТИКУ</button>
    <span id="an_status" style="font-size:11px;color:var(--txt3);"></span>
  </div>
  <div style="font-size:10px;color:var(--txt3);margin-bottom:6px;">Тикеры берутся из выбранных в «Симуляция».</div>
</div>

<div class="panel" id="an_summary_panel" style="display:none;">
  <div class="sec-lg">Сводка</div>
  <div id="an_summary" style="font-size:12px;color:var(--txt2);"></div>
</div>

<div class="panel" id="an_charts_panel" style="display:none;">
  <div class="sec-lg">Equity-кривая (виртуальный счёт)</div>
  <canvas id="an_eq_canvas" style="width:100%;height:260px;display:block;background:var(--card);border-radius:10px;border:1px solid var(--border);margin-bottom:16px;"></canvas>

  <div class="sec-lg">Rolling winrate (окно 20 сделок)</div>
  <canvas id="an_wr_canvas" style="width:100%;height:180px;display:block;background:var(--card);border-radius:10px;border:1px solid var(--border);margin-bottom:16px;"></canvas>

  <div class="sec-lg">Кривая обучения (накопленный winrate vs число сделок)</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:6px;">
    Если модель учится — линия должна расти. Плоская = случайное угадывание.
  </div>
  <canvas id="an_lc_canvas" style="width:100%;height:180px;display:block;background:var(--card);border-radius:10px;border:1px solid var(--border);margin-bottom:16px;"></canvas>

  <div class="sec-lg">По неделям</div>
  <table class="scen-table" id="an_weekly_table">
    <thead><tr><th>Неделя</th><th>Сделок</th><th>Win%</th><th>P&L ₽</th></tr></thead>
    <tbody></tbody>
  </table>
</div>

<div class="panel" id="an_model_panel" style="display:none;">
  <div class="sec-lg">M1/M2/M3 — статистика согласия/несогласия</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:8px;">
    «Несогласие» = модель дала противоположный сигнал, но сделка всё равно прошла через композит.
    Высокий % несогласия при низком WR = модель сигнализировала опасность, которую проигнорировали.
  </div>
  <table class="scen-table">
    <thead><tr><th>Модель</th><th>Согласна</th><th>Win% (согл)</th><th>Не согласна</th><th>Win% (не согл)</th></tr></thead>
    <tbody id="an_model_tbody"></tbody>
  </table>
</div>

<div class="panel" id="an_methods_panel" style="display:none;">
  <div class="sec-lg">Методы стратегии — agree/disagree</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:8px;">
    Для каждого метода: сколько раз он голосовал <b style="color:var(--pos)">за</b> направление сделки (и win%),
    сколько раз <b style="color:var(--neg)">против</b>. Методы с высоким disagree_n + низким disagree_wr — ценные фильтры,
    которые стоит усилить. |score| &gt; 0.05 считается активным голосом.
  </div>
  <div style="margin-bottom:8px;">
    <button class="btn-pill btn-sm" onclick="_anSortMethods('agree_n')">▼ по n</button>
    <button class="btn-pill btn-sm" onclick="_anSortMethods('agree_wr')">▼ по WR (согл)</button>
    <button class="btn-pill btn-sm" onclick="_anSortMethods('disagree_n')">▼ по против</button>
    <button class="btn-pill btn-sm" onclick="_anSortMethods('delta_wr')">▼ по Δ WR</button>
  </div>
  <table class="scen-table" id="an_methods_table">
    <thead><tr>
      <th>Метод</th>
      <th title="сколько раз метод голосовал за направление сделки">За (n)</th>
      <th>WR за</th>
      <th title="сколько раз метод голосовал против направления сделки">Против (n)</th>
      <th>WR против</th>
      <th title="WR(за) - WR(против): чем выше — тем метод полезнее">Δ WR</th>
    </tr></thead>
    <tbody id="an_methods_tbody"></tbody>
  </table>
</div>

</div><!-- /tab-analytics -->

<!-- ══════════════════════ TAB: ДИАГНОСТИКА ══════════════════════ -->
<div class="tab-pane" id="tab-diag">

<div class="panel">
  <div class="sec-lg">Веса методов / Диагностика стратегии</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:8px;">
    Снимок текущего состояния на живой истории (data/history.json) для
    одного тикера: Hedge-вес метода (oi_weights.json), смесь
    regime_mods по вероятностям режима, RMT-redundancy по режиму
    (Layer 4) и итоговый эффективный вес каждого метода в композите.
    Не запускает сделки, ничего не меняет.
  </div>
  <label>Тикер <input type="text" class="inp mid" id="diag_ticker" placeholder="SBER"></label>
  <label>Дней истории <input type="number" class="inp mid" id="diag_days" value="30" min="5" max="240"></label>
  <button class="btn-pill" onclick="loadDiagnostics()">▶ ПОСМОТРЕТЬ</button>
  <div id="diag_summary" style="font-size:11px;color:var(--txt3);margin-top:8px;"></div>
  <table class="scen-table" id="diag_table"></table>
</div>

<div class="panel">
  <div class="sec-lg">Авто-подобранные ATR_TAKE_K / ATR_STOP_K</div>
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

<div class="panel">
  <div class="sec-lg">Совет по багам</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:8px;">
    Лог пишется в файл <b style="color:var(--txt2)">dashboard.log</b> (рядом с dashboard.py) —
    открой его текстовым редактором и скопируй нужный кусок сюда.
  </div>
  <textarea id="bugtext" placeholder="Вставь traceback или лог..."></textarea><br><br>
  <button class="btn-pill" onclick="askCouncil()">СПРОСИТЬ СОВЕТ</button>
  <div id="council_answer"></div>
</div>

</div><!-- /tab-diag -->

<!-- ══════════════════════ TAB: BAR SCORES ══════════════════════ -->
<div class="tab-pane" id="tab-barscores">

<div class="panel">
  <div class="sec-lg">Серийная качка Bar Scores</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:10px;">
    Экспорт CSV со скорами всех методов по каждому бару для AI-анализа.
    Файлы сохраняются в <b style="color:var(--txt2)">data/bar_scores/</b>.
  </div>

  <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;">
      Глубина (дней):
      <select id="bs_days" class="inp" style="border-radius:6px;padding:4px 8px;width:90px;">
        <option value="90">90</option>
        <option value="180">180</option>
        <option value="365" selected>365</option>
        <option value="730">730</option>
      </select>
    </label>
    <button class="btn-pill btn-sm" onclick="bsSelectAll()">☑ все</button>
    <button class="btn-pill btn-sm" onclick="bsSelectNone()">☐ сбросить</button>
    <button class="btn-pill" id="bs_run_btn" onclick="bsStartBatch()">▶ КАЧАТЬ</button>
    <button class="btn-pill btn-sm" onclick="bsLoadFiles()">⟳ файлы</button>
  </div>

  <div id="bs_ticker_grid" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;"></div>

  <div id="bs_progress_wrap" style="display:none;">
    <div class="sec-sm" style="margin-bottom:6px;">Прогресс</div>
    <div id="bs_progress_log" style="font-size:11px;font-family:monospace;background:var(--card);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;max-height:180px;overflow-y:auto;line-height:1.7;"></div>
  </div>
</div>

<div class="panel">
  <div class="sec-lg">Сохранённые файлы</div>
  <div id="bs_files_wrap">
    <div style="font-size:11px;color:var(--txt3);">нажми ⟳ файлы выше</div>
  </div>
</div>

<div class="panel">
  <div class="sec-lg">Анализ паттернов (CART)</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:10px;">
    Ищет конъюнктивные правила «если метод A > X и метод B ≤ Y → avg fwd_ret = Z%».
    Запускает <b style="color:var(--txt2)">bar_rule_miner.py</b> на сохранённых CSV.
    Результаты в <b style="color:var(--txt2)">data/bar_rules/</b>.
  </div>
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
    <label style="font-size:12px;">Тикер:
      <select id="br_ticker" class="inp" style="border-radius:6px;padding:4px 8px;width:100px;"></select>
    </label>
    <label style="font-size:12px;">Цель:
      <select id="br_target" class="inp" style="border-radius:6px;padding:4px 8px;">
        <option value="fwd_ret_3">fwd_ret_3 (+3 бара ~15м)</option>
        <option value="fwd_ret_6">fwd_ret_6 (+6 баров ~30м)</option>
        <option value="fwd_ret_12">fwd_ret_12 (+12 баров ~1ч)</option>
        <option value="fwd_ret_24">fwd_ret_24 (+24 бара ~2ч)</option>
        <option value="fwd_ret_48">fwd_ret_48 (+48 баров ~4ч)</option>
      </select>
    </label>
    <label style="font-size:12px;">Глубина:
      <input type="number" id="br_depth" value="4" min="2" max="6" class="inp" style="width:50px;border-radius:6px;padding:4px 8px;">
    </label>
    <label style="font-size:12px;">Фильтр:
      <select id="br_filter" class="inp" style="border-radius:6px;padding:4px 6px;">
        <option value="all">все бары</option>
        <option value="reversals">развороты</option>
        <option value="regime_change">смена режима</option>
        <option value="high_vol">высокий объём</option>
        <option value="combined">все события</option>
      </select>
    </label>
    <button class="btn-pill" id="br_run_btn" onclick="brRunMiner()">▶ НАЙТИ ПРАВИЛА</button>
    <button class="btn-pill btn-sm" onclick="brLoadRules()">⟳ загрузить</button>
  </div>
  <div id="br_miner_status" style="font-size:11px;color:var(--txt3);margin-bottom:8px;"></div>

  <details style="margin-top:10px;">
    <summary style="font-size:11px;color:var(--txt2);cursor:pointer;font-weight:700;">▸ Применить правила к другому тикеру (фьючерс / кросс-проверка)</summary>
    <div style="padding:8px 0 0 0;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <label style="font-size:12px;">Применить к:
        <select id="br_apply_to" class="inp" style="border-radius:6px;padding:4px 8px;width:110px;"></select>
      </label>
      <button class="btn-pill btn-sm" onclick="brApplyRules()">▶ ПРИМЕНИТЬ</button>
    </div>
    <div id="br_apply_status" style="font-size:11px;color:var(--txt3);margin-top:6px;"></div>
    <div id="br_apply_rules_wrap" style="margin-top:8px;"></div>
  </details>

  <div id="br_rules_wrap" style="margin-top:12px;"></div>
</div>

</div><!-- /tab-barscores -->

<!-- ══════════════════════ TAB: БОТ (LIVE) ══════════════════════ -->
<div class="tab-pane" id="tab-live">

<!-- суб-табы -->
<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
  <button class="btn-pill" id="live-sub-btn-ctrl"   onclick="liveSub('ctrl')"   style="opacity:1;">📡 Управление</button>
  <button class="btn-pill" id="live-sub-btn-cfg"    onclick="liveSub('cfg')"    style="opacity:.5;">⚙️ Настройки</button>
  <button class="btn-pill" id="live-sub-btn-chart"  onclick="liveSub('chart')"  style="opacity:.5;">📊 График</button>
  <button class="btn-pill" id="live-sub-btn-council" onclick="liveSub('council')" style="opacity:.5;">🧠 Консилиум</button>
  <button class="btn-pill" id="live-sub-btn-oi"     onclick="liveSub('oi')"     style="opacity:.5;">📥 OI</button>
</div>

<!-- ══ СУБ-ТАБ: УПРАВЛЕНИЕ ══ -->
<div id="live-sub-ctrl">
<div class="panel" id="supervisor_panel">
  <div class="sec-lg">Процесс бота (main.py)</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:10px;">
    Дашборд и торговый цикл — разные процессы. Здесь — запуск/остановка самого
    main.py, отдельно от паузы ниже (пауза просто не даёт уже запущенному боту
    открывать новые позиции).
  </div>
  <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px;">
    <span id="sup_state_dot" class="sdot"></span>
    <span id="sup_state_label" style="font-size:12px;font-weight:600;color:var(--txt2);">загружаем...</span>
    <select class="inp mid" id="sup_mode_sel" style="width:150px;">
      <option value="sandbox" selected>🏖 Песочница (виртуально)</option>
      <option value="live">💸 Боевой (реальные деньги)</option>
    </select>
    <button class="btn-pill btn-sm" id="btn_sup_start" onclick="supervisorStart()">▶ Запустить</button>
    <button class="btn-pill btn-sm danger" id="btn_sup_stop" onclick="supervisorStop()" style="display:none;">⏹ Остановить</button>
    <button class="btn-pill btn-sm danger" id="btn_sup_kill" onclick="supervisorKill()" style="display:none;">✕ Принудительно</button>
    <button class="btn-pill btn-sm" onclick="loadSupervisorStatus()">⟳</button>
  </div>
  <div id="sup_status" style="font-size:11px;color:var(--txt3);"></div>
  <details style="margin-top:10px;">
    <summary style="cursor:pointer;font-size:11px;color:var(--txt3);">Лог процесса (data/bot_run.log, последние строки)</summary>
    <pre id="sup_log" style="font-size:10px;color:var(--txt2);white-space:pre-wrap;max-height:220px;overflow-y:auto;background:var(--panel);border-radius:8px;padding:8px;margin-top:6px;"></pre>
  </details>
</div>
<div class="panel">
  <div class="sec-lg">Статус и управление</div>
  <div id="bot_status_bar" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px;">
    <span id="bot_state_dot" class="sdot"></span>
    <span id="bot_state_label" style="font-size:12px;font-weight:600;color:var(--txt2);">загружаем...</span>
    <button class="btn-pill btn-sm" id="btn_pause" onclick="botPause()">⏸ Пауза</button>
    <button class="btn-pill btn-sm" id="btn_resume" onclick="botResume()" style="display:none;">▶ Возобновить</button>
    <button class="btn-pill btn-sm" onclick="loadBotStatus()">⟳</button>
    <span style="font-size:10px;color:var(--txt3);">авто-обновление каждые 30с</span>
  </div>
  <div id="bot_risk" style="font-size:11px;color:var(--txt2);padding:6px 10px;background:var(--card);border-radius:8px;border:1px solid var(--border2);margin-bottom:10px;display:none;"></div>
  <div class="sec" style="margin-bottom:6px;">Открытые позиции</div>
  <div id="bot_positions" style="font-size:11px;color:var(--txt3);">нет данных</div>
  <div id="bot_closed_today" style="display:none;"></div>
  <div style="margin-top:12px;">
    <div class="sec" style="margin-bottom:6px;">Срочное закрытие позиции</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <select class="inp mid" id="close_ticker_sel" style="min-width:120px;"></select>
      <button class="btn-pill btn-sm danger" onclick="botClose()">✕ Закрыть</button>
      <button class="btn-pill btn-sm danger" onclick="botCloseAll()">✕ Закрыть все</button>
      <span id="close_status" style="font-size:11px;color:var(--txt3);"></span>
    </div>
  </div>
  <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border2);">
    <div class="sec" style="margin-bottom:8px;">Передать ручную позицию боту</div>
    <div style="font-size:11px;color:var(--txt3);margin-bottom:10px;">
      Открыл позицию в терминале — бот возьмёт её под управление: трейлинг-стоп,
      безубыток после 1R, закрытие на тейке. Сработает на следующей свече.
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <label>Тикер <input type="text" class="inp mid" id="adopt_ticker" placeholder="SBER" style="width:80px;"></label>
      <label>Направление
        <select class="inp" id="adopt_dir" style="width:90px;">
          <option value="LONG">LONG</option>
          <option value="SHORT">SHORT</option>
        </select>
      </label>
      <label>Тейк <input type="number" class="inp mid" id="adopt_take" placeholder="250.00" step="0.01" style="width:90px;"></label>
      <label>Стоп <input type="number" class="inp mid" id="adopt_stop" placeholder="240.00" step="0.01" style="width:90px;"></label>
      <label>Вход <input type="number" class="inp mid" id="adopt_entry" placeholder="(текущая)" step="0.01" style="width:90px;"></label>
      <button class="btn-pill btn-sm" onclick="botAdopt()">📥 Передать боту</button>
    </div>
    <div id="adopt_status" style="font-size:11px;color:var(--txt3);margin-top:6px;"></div>
  </div>
  <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border2);">
    <div class="sec" style="margin-bottom:8px;">Переставить стоп/тейк открытой позиции</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <label>Тикер <input type="text" class="inp mid" id="ms_ticker" placeholder="SBER" style="width:80px;"></label>
      <label>Новый стоп <input type="number" class="inp mid" id="ms_stop" placeholder="242.00" step="0.01" style="width:90px;"></label>
      <label>Новый тейк <input type="number" class="inp mid" id="ms_take" placeholder="(не менять)" step="0.01" style="width:100px;"></label>
      <button class="btn-pill btn-sm" onclick="botMoveStop()">📐 Переставить</button>
    </div>
    <div id="ms_status" style="font-size:11px;color:var(--txt3);margin-top:6px;"></div>
  </div>
</div>

</div><!-- /live-sub-ctrl -->

<!-- ══ СУБ-ТАБ: НАСТРОЙКИ ══ -->
<div id="live-sub-cfg" style="display:none;">
<div class="panel">
  <div class="sec-lg">Глобальные настройки бота</div>
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
  <label><input type="checkbox" id="ov_orderbook"> Стакан (10 уровней): срочный выход по дисбалансу заявок
    (доп. живая подписка к API, выключено по умолчанию; работает только вместе с адаптивным выходом)
  </label>
  <br><br>
  <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap">
    <label style="display:flex;flex-direction:column;gap:4px;font-size:12px">
      Дневной лимит убытка, %
      <input type="number" step="0.1" min="0.1" max="100" class="inp mid" id="ov_daily_loss" placeholder="2">
    </label>
    <label style="display:flex;flex-direction:column;gap:4px;font-size:12px">
      Недельный лимит убытка, %
      <input type="number" step="0.1" min="0.1" max="100" class="inp mid" id="ov_weekly_loss" placeholder="5">
    </label>
    <label style="display:flex;flex-direction:column;gap:4px;font-size:12px">
      Месячный лимит убытка, %
      <input type="number" step="0.1" min="0.1" max="100" class="inp mid" id="ov_monthly_loss" placeholder="10">
    </label>
  </div>
  <br>
  <button class="btn-pill" onclick="loadOverrides()">⟳ ЗАГРУЗИТЬ ТЕКУЩИЕ</button>
  <button class="btn-pill" onclick="saveOverrides()">💾 СОХРАНИТЬ</button>
  <span id="ov_status"></span>
</div>

<div class="panel">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
    <div class="sec-lg" style="margin:0;">Настройки по тикерам</div>
    <button class="btn-pill btn-sm" onclick="ovBulk('enabled',true)">✅ Все торговать</button>
    <button class="btn-pill btn-sm" onclick="ovBulk('enabled',false)">⏸ Все паузу</button>
    <button class="btn-pill btn-sm" onclick="ovBulk('signal_only',true)">🔔 Все сигнал</button>
    <button class="btn-pill btn-sm" onclick="ovBulk('signal_only',false)">💸 Все торговля</button>
    <button class="btn-pill btn-sm warn" onclick="pruneStaleOiTickers()" title="Убрать тикеры, которых нет в settings.ini/[FUTURES_TRADING] И по которым никогда не считался бэктест на этой машине — старый мусор из oi_tickers.json (импорт oi-signal-v10.html)">🧹 Убрать хлам (OI-импорт без истории)</button>
    <button class="btn-pill btn-sm warn" onclick="pruneFailedOiTickers()" title="Из последнего прогона убрать тикеры со статусом «нет истории»/«ошибка API»/«ошибка» — те, что стабильно ломаются раз за разом и висят в списке впустую. settings.ini/FUTURES_TRADING не тронется.">🧹 Убрать упавшие в последнем прогоне</button>
  </div>
  <div style="font-size:11px;color:var(--txt3);margin:-4px 0 8px;">
    Бейдж <b>OI-импорт</b> — тикер попал в список только из oi_tickers.json (старый экспорт oi-signal-v10.html),
    не из settings.ini. «✗» — по нему нет ни одного локально закэшированного бэктеста. Бейдж <b>ini</b> —
    сконфигурирован в settings.ini или резолвится как фьючерс [FUTURES_TRADING], удалять тут нечего.
  </div>
  <table class="scen-table">
    <thead><tr>
      <th>Тикер</th><th>Торгуется</th><th>Режим (signal_only)</th>
      <th>LONG Take</th><th>LONG Stop</th><th>SHORT Take</th><th>SHORT Stop</th>
    </tr></thead>
    <tbody id="ov_table"></tbody>
  </table>
</div>

<div class="panel" id="universe_panel">
  <div class="sec-lg">Тикеры для торговли (фьючерсы)</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:10px;">
    Что попадёт в [FUTURES_TRADING] BASE_TICKERS. Применяется со СЛЕДУЮЩЕГО
    торгового дня (список читается раз в день, не мгновенно посреди сессии) —
    см. ticker_universe.py.
  </div>
  <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px;">
    <label class="cfg-check"><input type="radio" name="uv_mode" value="manual" onchange="universeModeChanged()"> Ручной список</label>
    <label class="cfg-check"><input type="radio" name="uv_mode" value="top_n" onchange="universeModeChanged()"> Топ-N по востребованности</label>
  </div>

  <div id="uv_manual_block">
    <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--txt2);">
      Тикеры через запятую (как basic_asset — тикер акции или человекочитаемое
      имя вроде «Brent», «Золото», «USD/RUB»)
      <textarea id="uv_manual_tickers" style="height:70px;" placeholder="SBER,GAZP,LKOH,IMOEX,Золото"></textarea>
    </label>
  </div>

  <div id="uv_topn_block" style="display:none;">
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px;">
      <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--txt2);">
        N (сколько взять)
        <input type="number" class="inp mid" id="uv_n" value="20" min="1" max="150" style="width:70px;">
      </label>
      <button class="btn-pill btn-sm" onclick="universeCompute()">📊 Посчитать востребованность</button>
      <span id="uv_compute_status" style="font-size:11px;color:var(--txt3);"></span>
    </div>
    <div style="font-size:10px;color:var(--txt3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Типы активов (включить)</div>
    <div id="uv_types" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px;"></div>
    <div id="uv_preview" style="font-size:11px;color:var(--txt2);"></div>
  </div>

  <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border2);display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
    <button class="btn-pill" onclick="universeSave()">💾 Сохранить и применить со следующего дня</button>
    <span id="uv_save_status" style="font-size:11px;color:var(--txt3);"></span>
  </div>
  <div style="margin-top:8px;font-size:11px;color:var(--txt3);">
    Сейчас в BASE_TICKERS: <span id="uv_resolved_current" style="color:var(--txt2);">—</span>
  </div>
</div>

</div><!-- /live-sub-cfg -->

<!-- ══ СУБ-ТАБ: ГРАФИК СДЕЛОК ══ -->
<div id="live-sub-chart" style="display:none;">
<div class="panel">
  <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px;">
    <div class="sec-lg" style="margin:0;">График сделок (live)</div>
    <select class="inp mid" id="lc_ticker" style="width:90px;"></select>
    <select class="inp mid" id="lc_days" style="width:80px;">
      <option value="3">3 дня</option>
      <option value="7" selected>7 дней</option>
      <option value="14">14 дней</option>
      <option value="30">30 дней</option>
    </select>
    <button class="btn-pill btn-sm" onclick="loadLiveChart()">⟳ Обновить</button>
    <span id="lc_status" style="font-size:11px;color:var(--txt3);"></span>
  </div>
  <div id="lc_chart" style="width:100%;height:400px;background:var(--card);border-radius:8px;border:1px solid var(--border2);position:relative;">
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--txt3);font-size:12px;" id="lc_placeholder">Выбери тикер и нажми ⟳</div>
    <canvas id="lc_canvas" style="display:none;width:100%;height:100%;"></canvas>
  </div>
  <div id="lc_trades_list" style="margin-top:8px;font-size:11px;color:var(--txt2);"></div>
</div>

<div class="panel">
  <div class="sec-lg">Fitness scorecard</div>
  <div id="live_scorecard" style="font-size:12px;color:var(--txt2);">загрузка...</div>
  <div style="margin-top:10px;font-size:11px;color:var(--txt3);" id="live_per_ticker"></div>
</div>

</div><!-- /live-sub-chart -->

<!-- ══ СУБ-ТАБ: КОНСИЛИУМ ══ -->
<div id="live-sub-council" style="display:none;">

<div class="panel">
  <div class="sec-lg">Запрос к консилиуму</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:10px;">
    Задай вопрос агентам-аналитикам. Альфа строит тезис, Бета критикует, Модератор резюмирует.
    Можно спросить по конкретному тикеру или задать общий вопрос.
  </div>
  <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;">
    <div style="display:flex;flex-direction:column;gap:4px;flex:1;min-width:260px;">
      <div style="display:flex;gap:8px;">
        <input type="text" class="inp mid" id="ca_ticker" placeholder="Тикер (напр. SBER)" style="width:120px;">
        <select class="inp" id="ca_direction" style="width:100px;">
          <option value="LONG">LONG</option>
          <option value="SHORT">SHORT</option>
        </select>
      </div>
      <textarea class="inp" id="ca_question" placeholder="Вопрос или контекст (необязательно)..." rows="3" style="width:100%;resize:vertical;font-family:inherit;"></textarea>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;">
      <button class="btn-pill" onclick="councilAsk()" id="ca_btn">🧠 Спросить</button>
      <span style="font-size:10px;color:var(--txt3);">~20-35 секунд</span>
    </div>
  </div>
  <div id="ca_status" style="font-size:11px;color:var(--txt3);margin-top:6px;"></div>
  <div id="ca_result" style="margin-top:12px;display:none;">
    <div style="background:var(--card);border:1px solid var(--border2);border-radius:8px;padding:12px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <span id="ca_verdict_badge" style="font-size:13px;font-weight:700;padding:3px 10px;border-radius:6px;"></span>
        <span id="ca_confidence" style="font-size:11px;color:var(--txt3);"></span>
      </div>
      <div id="ca_reason" style="font-size:12px;color:var(--txt2);white-space:pre-wrap;"></div>
      <details style="margin-top:8px;">
        <summary style="font-size:11px;color:var(--txt3);cursor:pointer;">Полный диалог агентов</summary>
        <div id="ca_dialog" style="font-size:11px;color:var(--txt2);margin-top:6px;white-space:pre-wrap;"></div>
      </details>
    </div>
  </div>
</div>

<div class="panel">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
    <div class="sec-lg" style="margin:0;">История решений консилиума</div>
    <button class="btn-pill btn-sm" onclick="loadCouncilLog()">⟳</button>
  </div>
  <div id="live_council" style="font-size:11px;color:var(--txt2);max-height:400px;overflow-y:auto;">загрузка...</div>
</div>

</div><!-- /live-sub-council -->

<!-- ══ СУБ-ТАБ: OI ══ -->
<div id="live-sub-oi" style="display:none;">
<div class="panel">
  <div class="sec-lg">Токен MOEX AlgoPack</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:10px;">
    Все ОИ/микроструктурные методы (squeeze, INST_OI, tradestats, MEGA-ALERTS, бэкфилл ниже)
    ходят по этому ключу. Смена здесь пишет прямо в <code>settings.ini [MOEX] TOKEN=</code>
    (точечно, комментарии файла не трогает) — живые поллеры подхватывают новый ключ на
    следующем цикле (до 5 мин), рестарт бота не нужен.
  </div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
    <span id="moex_token_status" style="font-size:12px;color:var(--txt2);">…</span>
    <input type="password" class="inp mid" id="moex_token_input" placeholder="новый токен AlgoPack" style="width:340px;" autocomplete="off">
    <button class="btn-pill btn-sm ok" onclick="saveMoexToken()">Сохранить</button>
    <button class="btn-pill btn-sm ghost" onclick="toggleMoexTokenVisible()">👁</button>
  </div>
  <div id="moex_token_msg" style="font-size:11px;color:var(--txt3);"></div>
</div>
<div class="panel">
  <div class="sec-lg">Исторический OI (AlgoPack)</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:10px;">
    Загружает данные открытого интереса (юр/физ) с MOEX AlgoPack за выбранный период.
    Тикеры фьючерсных контрактов запрашиваются автоматически с MOEX ISS по каждой дате.
    Требует токен <code>[MOEX] TOKEN=</code> в settings.ini (см. панель выше).
  </div>
  <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
    <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">Период
      <select class="inp mid" id="oi_bf_months" style="width:100px;">
        <option value="3">3 мес.</option>
        <option value="6">6 мес.</option>
        <option value="12" selected>12 мес.</option>
        <option value="24">24 мес.</option>
      </select>
    </label>
    <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">Тикеры (через запятую)
      <input type="text" class="inp mid" id="oi_bf_tickers" placeholder="пусто = все из settings.ini" style="width:240px;">
    </label>
    <div style="display:flex;flex-direction:column;gap:6px;padding-top:16px;">
      <button class="btn-pill" onclick="oiBackfill()" id="oi_bf_btn">⬇ Загрузить с MOEX</button>
      <button class="btn-pill btn-sm" onclick="oiBackfillStatus()">⟳ Статус</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;padding-top:16px;">
      <button class="btn-pill" onclick="oiSyncWorker()" id="oi_sync_btn" title="Забрать уже собранный ОИ из Cloudflare D1-воркера (быстро, без MOEX) в локальный файл, который читает бэктест">⚡ Забрать из воркера (D1)</button>
      <button class="btn-pill btn-sm" onclick="oiWorkerCatalog()" id="oi_cat_btn" title="Показать, что реально лежит в воркере и находится ли матч под наши тикеры">🔎 что в воркере</button>
    </div>
  </div>
  <div id="oi_bf_status" style="font-size:12px;color:var(--txt2);padding:8px;background:var(--card);border-radius:6px;border:1px solid var(--border2);min-height:30px;">
    Не запущено
  </div>
  <div id="oi_bf_log" style="margin-top:8px;font-size:11px;color:var(--txt2);max-height:200px;overflow-y:auto;display:none;"></div>
</div>
</div><!-- /live-sub-oi -->

</div><!-- /tab-live -->

</div><!-- /main-col -->
</div><!-- /app-layout -->

<script>
// Глобальная ловля ошибок UI: непойманные JS-исключения (window 'error') и
// утонувшие промисы/fetch'и (unhandledrejection) шлём на /api/client_error →
// тот же серверный лог, плюс баннер снизу. Раньше такие ошибки молча тонули
// в консоли браузера. Ставим ПЕРВЫМ делом, чтобы ловить с начала загрузки.
(function() {{
  let _n = 0, _bar = null;
  function _banner(text) {{
    try {{
      if (!document.body) return;
      if (!_bar) {{
        _bar = document.createElement('div');
        _bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99998;background:#7f1d1d;color:#fff;font:11px/1.4 monospace;padding:5px 12px;max-height:30%;overflow:auto;';
        document.body.appendChild(_bar);
      }}
      _bar.textContent = '⚠ Ошибка в интерфейсе (записана в лог сервера): ' + text;
    }} catch (e) {{}}
  }}
  function _report(kind, msg, extra) {{
    if (_n >= 10) return;
    _n++;
    try {{
      fetch('/api/client_error', {{
        method: 'POST',
        headers: {{'Content-Type': 'application/json'}},
        body: JSON.stringify({{kind: kind, message: String(msg), extra: String(extra || ''), url: location.pathname}})
      }}).catch(function() {{}});
    }} catch (e) {{}}
    _banner(kind + ': ' + msg);
  }}
  window.addEventListener('error', function(ev) {{
    _report('js-error', ev.message || 'unknown', (ev.filename || '') + ':' + (ev.lineno || ''));
  }});
  window.addEventListener('unhandledrejection', function(ev) {{
    var r = ev.reason;
    _report('promise', (r && r.message) ? r.message : String(r), (r && r.stack) ? r.stack : '');
  }});
}})();

function toggleSidebar() {{
  const sb = document.getElementById('sidebar');
  const collapsed = sb.classList.toggle('collapsed');
  document.getElementById('sidebarOpenBtn').classList.toggle('show', collapsed);
  try {{ localStorage.setItem('ba_sidebar_collapsed', collapsed ? '1' : '0'); }} catch (e) {{}}
}}
(function() {{
  let collapsed = false;
  try {{ collapsed = localStorage.getItem('ba_sidebar_collapsed') === '1'; }} catch (e) {{}}
  if (collapsed) {{
    document.getElementById('sidebar').classList.add('collapsed');
    document.getElementById('sidebarOpenBtn').classList.add('show');
  }}
}})();
document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => c.classList.toggle('active')));

function setAllChips(active) {{
  document.querySelectorAll('.chip').forEach(c => {{
    if (c.style.display !== 'none') {{
      active ? c.classList.add('active') : c.classList.remove('active');
    }}
  }});
}}

function toggleCatPanel(panelId, btn) {{
  const panel = document.querySelector(`.cat-panel[data-panel="${{panelId}}"]`);
  if (!panel) return;
  const chips = panel.querySelectorAll('.chip');
  const anyActive = Array.from(chips).some(c => c.classList.contains('active'));
  chips.forEach(c => anyActive ? c.classList.remove('active') : c.classList.add('active'));
  btn.style.color = anyActive ? 'var(--txt3)' : 'var(--accent)';
}}

let _statusPollTimer = null;

function showTab(name) {{
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  event.currentTarget.classList.add('active');
  if (name === 'live') {{
    liveSub('ctrl');
    loadBotStatus(); loadOverrides(); loadAutoAtr(); loadSupervisorStatus(); loadUniverse();
    if (!_statusPollTimer) _statusPollTimer = setInterval(() => {{ loadBotStatus(); loadSupervisorStatus(); }}, 30000);
  }} else {{
    if (_statusPollTimer) {{ clearInterval(_statusPollTimer); _statusPollTimer = null; }}
  }}
  if (name === 'barscores') {{ bsInit(); brPopulateTickers(); }}
}}

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
    let dis = '';
    if (s.disagree_n > 0) {{
      const disPct = s.disagree_win_rate !== null ? (s.disagree_win_rate * 100).toFixed(0) + '%' : '—';
      dis = ` <span style="color:var(--neg)" title="сделок где модель была против направления">(против: ${{s.disagree_n}}, ${{disPct}})</span>`;
    }}
    parts.push(`${{name.replace('_CLUSTER', '')}}: ${{agreePct}} (n=${{s.agree_n}}${{dur}})${{dis}}`);
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
    if (!s || !s.n_trades) continue;
    if (s.pnl_rub !== undefined) {{
      parts.push(`${{labels[key.toLowerCase()]}}: ${{s.pnl_rub.toFixed(0)}}₽ (n=${{s.n_trades}})`);
    }} else {{
      const wr = s.win_rate !== null && s.win_rate !== undefined ? (s.win_rate * 100).toFixed(0) + '%' : '—';
      const exp = s.expectancy_pct !== null && s.expectancy_pct !== undefined
        ? `, эксп ${{(s.expectancy_pct * 100).toFixed(2)}}%` : '';
      parts.push(`${{labels[key.toLowerCase()]}}: ${{wr}} (n=${{s.n_trades}}${{exp}})`);
    }}
  }}
  return parts.join(' / ');
}}

// Подсказки к методам — что значит каждый сигнал.
const _METHOD_HINTS = {{
  PRICE_TREND: 'Ценовой тренд: MA-5 vs MA-20 — куда смотрит рынок за несколько дней',
  VOL_MOMENTUM: 'Объёмный моментум: объём ускоряется vs замедляется — подтверждение движения',
  OI_PRESSURE: 'Давление открытого интереса: накопление vs снижение OI — кто держит позицию',
  FUNDING_SIGNAL: 'Ставка финансирования: слишком много лонгов/шортов на рынке — контрарный',
  TICK_FLOW: 'Поток тиков (агрессоры): buy vs sell тиков — моментальное давление',
  SPREAD_REGIME: 'Режим спреда: узкий=ликвидность есть, широкий=риск исполнения',
  NOISE_RATIO: 'Соотношение сигнал/шум: высокий шум = выходим из рынка, низкий = торгуем',
  CLUSTER_BIAS: 'Кластерный перекос: крупные участники покупают или продают',
  IMBALANCE_SIGNAL: 'Дисбаланс стакана: аск vs бид навес — где стена',
  LARGE_TRADE_SIGNAL: 'Крупные сделки: куда идут «слоны» — smart money tracker',
  TAPE_SPEED: 'Скорость ленты: рынок ускоряется — ловим моментум',
  TAPE_DIRECTION: 'Направление ленты: средневзвешенное направление последних сделок',
  PRICE_ACCEL: 'Ускорение/замедление движения: бары нарастают (тренд разгоняется) или затухают (истощение перед разворотом)',
  CUMUL_DELTA: 'Накопленный tick-flow за ~1.5ч: агрессия покупателей/продавцов нарастает или падает (Order Flow)',
  AMT_POC: 'Auction Market Theory: расстояние от бара с макс. объёмом (грубый POC). У POC = баланс, далеко = дисбаланс',
  VSA_ABSORPTION: 'VSA-поглощение: огромный объём + маленький ход — крупный участник поглощает противоположную сторону',
  CASCADE: 'Ликвидационный каскад: обнаружение волны стоп-аутов и контрарный сигнал на разворот после её завершения',
  IMPULSE_PULLBACK: 'Импульс/откат: слабый откат (<50% импульса) + низкий объём = продолжение тренда; глубокий откат (>65%) = ослабление',
  M1_NAME: 'ML-кластер M1: первая модель ансамбля на базе всех выше методов',
  M2_NAME: 'ML-кластер M2: вторая модель — другая кластеризация',
  M3_NAME: 'ML-кластер M3: третья модель — режимный фильтр',
}};

// Провайдерно-зависимые методы: если бот запущен без OI-провайдера или без
// tradestats — эти методы структурно молчат в этом прогоне, не потому что их
// выключили, а потому что нет данных. Пользователю важно различать: «выкл» vs
// «нет провайдера» vs «просто не голосовал в этой сессии».
const _PROVIDER_METHODS = new Set([
  'OI_SQUEEZE','INST_OI','RETAIL_CONTRA','DELTA_QUADRANT','OI_ABSORPTION',
  'BS_PRESSURE_TS','AGGRESSOR_FLOW','LARGE_IMPACT','VWAP_SIGNAL_TS',
  'VOL_MOMENTUM_TS','OB_IMBALANCE','CANCEL_SIGNAL',
  'INDEX_CONTEXT','MULTI_TICKER'
]);

// Определение статуса метода: работает / выкл вручную / нет провайдера /
// не голосовал в этой сессии (сработала фильтрация порогами).
function _methodStatusOf(name, s){
  const dis = !!s.disabled;
  const n = (s.agree_n||0) + (s.disagree_n||0);
  if (dis) return {icon:'👻', label:'выкл вручную', hint:'Метод выключен из панели «Отключить методы». Скор=0, вес не обучается. Винрейт ниже — теневой (что было бы если бы работал).', order:2};
  if (n === 0){
    if (_PROVIDER_METHODS.has(name)) return {icon:'🚫', label:'нет провайдера', hint:'Метод требует OI/tradestats/index/multi-ticker провайдера. В этой сессии данные не подключены — метод структурно молчит.', order:3};
    return {icon:'💤', label:'не голосовал', hint:'Метод считается, но за весь прогон ни разу не преодолел порог |скор|≥0.02 в момент входа. Возможные причины: слишком тихий рынок, слишком строгий порог метода, или порог входа в сделки настолько высокий, что этот метод просто не имел возможности проявиться.', order:4};
  }
  return {icon:'🟢', label:'работает', hint:`Метод активен, участвовал в ${{n}} сделках.`, order:1};
}

function methodStatsToHtml(ms) {{
  if (!ms || !Object.keys(ms).length) return '';
  // Раньше метод без сделок молча пропадал (filter agree>0||disagree>0) —
  // теперь виден со статусом, чтобы было понятно ПОЧЕМУ он не даёт цифр.
  const rows = Object.entries(ms).sort((a,b)=>{{
    const sa=_methodStatusOf(a[0],a[1]), sb=_methodStatusOf(b[0],b[1]);
    if (sa.order!==sb.order) return sa.order-sb.order;
    return (b[1].agree_n+b[1].disagree_n) - (a[1].agree_n+a[1].disagree_n);
  }});
  if (!rows.length) return '';
  const hasHedge = rows.some(([, s]) => s.hedge_weight != null);
  // Сводка по статусам сверху таблицы
  const summary = {{'работает':0,'выкл вручную':0,'нет провайдера':0,'не голосовал':0}};
  rows.forEach(([n,s])=>{{ summary[_methodStatusOf(n,s).label]++; }});
  let html = '<div style="font-size:10px;color:var(--txt3);margin-top:8px;margin-bottom:2px">'
           + Object.entries(summary).filter(([_,v])=>v>0)
                .map(([k,v])=>`${{k}}: <b style="color:var(--txt2)">${{v}}</b>`).join(' · ')
           + '</div>';
  const hasAltCompare = rows.some(([, s]) => s.alt_compared > 0);
  html += '<table style="font-size:11px;border-collapse:collapse;width:100%;margin-top:2px">';
  html += '<tr style="color:var(--txt3)"><th style="text-align:left;padding:1px 6px" title="🟢 работает · 👻 выкл вручную · 🚫 нет провайдера · 💤 считался, но не голосовал">•</th>'
        + '<th style="text-align:left;padding:1px 6px">метод</th>'
        + (hasHedge ? '<th style="padding:1px 6px" title="Hedge-вес [0..2]: обученный мультипликатор метода. 1.0=нейтральный, >1=усилен, <1=ослаблен">вес</th>' : '')
        + (hasAltCompare ? '<th style="padding:1px 6px" title="Alt-трансформация vs классика: 🔄N% = перевернул знак; ▲N% = alt сильнее классики; ▽N% = классика сильнее">alt vs классика</th>' : '')
        + '<th style="padding:1px 6px">за n</th><th style="padding:1px 6px">за win%</th>'
        + '<th style="padding:1px 6px">против n</th><th style="padding:1px 6px">против win%</th></tr>';
  for (const [name, s] of rows) {{
    const st = _methodStatusOf(name, s);
    const agWr = s.agree_win_rate !== null && s.agree_win_rate !== undefined ? (s.agree_win_rate*100).toFixed(0)+'%' : '—';
    const disWr = s.disagree_win_rate !== null && s.disagree_win_rate !== undefined ? (s.disagree_win_rate*100).toFixed(0)+'%' : '—';
    const agStyle = s.agree_win_rate !== null && s.agree_win_rate > 0.6 ? 'color:var(--pos)' : (s.agree_win_rate !== null && s.agree_win_rate < 0.4 ? 'color:var(--neg)' : '');
    const disStyle = s.disagree_win_rate !== null && s.disagree_win_rate > 0.6 ? 'color:var(--neg)' : (s.disagree_win_rate !== null && s.disagree_win_rate < 0.4 ? 'color:var(--pos)' : '');
    const hw = s.hedge_weight != null ? s.hedge_weight : null;
    const hwStyle = hw != null ? (hw > 1.1 ? 'color:var(--pos)' : hw < 0.9 ? 'color:var(--neg)' : 'color:var(--txt3)') : '';
    const hint = _METHOD_HINTS[name] || '';
    const rowOpacity = st.order===1 ? '' : (st.order===2 ? 'opacity:.65' : 'opacity:.45');
    const nameLbl = name.replace(/_/g,' ');
    // Ячейка alt vs классика: три компактных метрики или «—» если сравнения не было.
    let altCell = '—';
    if (s.alt_compared > 0){{
      const fr = s.alt_flip_rate!=null ? Math.round(s.alt_flip_rate*100) : 0;
      const asr = s.alt_stronger_rate!=null ? Math.round(s.alt_stronger_rate*100) : 0;
      const csr = s.classic_stronger_rate!=null ? Math.round(s.classic_stronger_rate*100) : 0;
      const parts = [];
      if (fr>0) parts.push(`<span style="color:var(--warn)" title="Alt перевернул знак классики в ${{fr}}% сделок">🔄${{fr}}%</span>`);
      if (asr>0) parts.push(`<span style="color:var(--pos)" title="Alt сильнее классики (|score|) в ${{asr}}% сделок">▲${{asr}}%</span>`);
      if (csr>0) parts.push(`<span style="color:var(--txt3)" title="Классика сильнее alt в ${{csr}}% сделок">▽${{csr}}%</span>`);
      altCell = parts.length ? parts.join(' ') : `<span style="color:var(--txt3)">= ${{s.alt_compared}}</span>`;
    }} else {{
      altCell = '<span style="color:var(--txt3)" title="У метода нет alt-семейства (структурный/OI/tradestats/M1-3) или прогон без alt-снимка">—</span>';
    }}
    html += `<tr title="${{hint}}" style="${{rowOpacity}}">`
          + `<td style="padding:1px 4px;cursor:help" title="${{st.hint.replace(/"/g,'&quot;')}}">${{st.icon}}</td>`
          + `<td style="padding:1px 6px">${{nameLbl}}</td>`
          + (hasHedge ? `<td style="text-align:right;padding:1px 6px;${{hwStyle}}">${{st.order===2 ? '—' : (hw != null ? hw.toFixed(3) : '—')}}</td>` : '')
          + (hasAltCompare ? `<td style="text-align:center;padding:1px 6px;font-size:10px">${{altCell}}</td>` : '')
          + `<td style="text-align:right;padding:1px 6px">${{s.agree_n}}</td>`
          + `<td style="text-align:right;padding:1px 6px;${{agStyle}}">${{agWr}}</td>`
          + `<td style="text-align:right;padding:1px 6px">${{s.disagree_n}}</td>`
          + `<td style="text-align:right;padding:1px 6px;${{disStyle}}">${{disWr}}</td></tr>`;
  }}
  html += '</table>';
  return html;
}}

// Сводная таблица весов методов по всем тикерам прогона.
// Показывает медианный Hedge-вес каждого метода и его attribution (согласие/disagreement).
function runWeightsSummaryToHtml(rows) {{
  if (!rows || !rows.length) return '';
  // Собираем статистику по каждому методу через все тикеры
  const methods = {{}};
  for (const r of rows) {{
    if (!r.method_stats) continue;
    for (const [name, s] of Object.entries(r.method_stats)) {{
      if (!methods[name]) methods[name] = {{weights: [], agree: 0, disagree: 0, agWins: 0, disWins: 0}};
      const m = methods[name];
      if (s.hedge_weight != null) m.weights.push(s.hedge_weight);
      m.agree += s.agree_n || 0;
      m.agWins += (s.agree_win_rate || 0) * (s.agree_n || 0);
      m.disagree += s.disagree_n || 0;
      m.disWins += (s.disagree_win_rate || 0) * (s.disagree_n || 0);
    }}
  }}
  const sorted = Object.entries(methods)
    .filter(([, m]) => m.weights.length > 0 || m.agree + m.disagree > 0)
    .sort((a, b) => {{
      const wa = a[1].weights.length ? a[1].weights.reduce((s,v)=>s+v,0)/a[1].weights.length : 1;
      const wb = b[1].weights.length ? b[1].weights.reduce((s,v)=>s+v,0)/b[1].weights.length : 1;
      return wb - wa;
    }});
  if (!sorted.length) return '';
  let html = '<table style="font-size:11px;border-collapse:collapse;width:100%;margin-top:6px">';
  html += `<tr style="color:var(--txt3)">
    <th style="text-align:left;padding:2px 6px">метод</th>
    <th style="padding:2px 6px" title="Среднее Hedge-вес по всем тикерам. >1=метод усилен обучением, <1=ослаблен">ср.вес</th>
    <th style="padding:2px 6px">за n</th><th style="padding:2px 6px">за win%</th>
    <th style="padding:2px 6px">против n</th><th style="padding:2px 6px">против win%</th>
  </tr>`;
  for (const [name, m] of sorted) {{
    const avgW = m.weights.length ? m.weights.reduce((s,v)=>s+v,0)/m.weights.length : null;
    const agWr = m.agree > 0 ? (m.agWins/m.agree*100).toFixed(0)+'%' : '—';
    const disWr = m.disagree > 0 ? (m.disWins/m.disagree*100).toFixed(0)+'%' : '—';
    const wStyle = avgW != null ? (avgW > 1.1 ? 'color:var(--pos);font-weight:bold' : avgW < 0.9 ? 'color:var(--neg)' : 'color:var(--txt3)') : '';
    const agStyle = m.agree > 0 ? (m.agWins/m.agree > 0.6 ? 'color:var(--pos)' : m.agWins/m.agree < 0.4 ? 'color:var(--neg)' : '') : '';
    const hint = _METHOD_HINTS[name] || '';
    html += `<tr title="${{hint}}">
      <td style="padding:2px 6px;white-space:nowrap">${{name.replace(/_/g,' ')}}</td>
      <td style="text-align:right;padding:2px 6px;${{wStyle}}">${{avgW != null ? avgW.toFixed(3) : '—'}}</td>
      <td style="text-align:right;padding:2px 6px">${{m.agree}}</td>
      <td style="text-align:right;padding:2px 6px;${{agStyle}}">${{agWr}}</td>
      <td style="text-align:right;padding:2px 6px">${{m.disagree}}</td>
      <td style="text-align:right;padding:2px 6px">${{disWr}}</td>
    </tr>`;
  }}
  html += '</table>';
  html += `<p style="font-size:10px;color:var(--txt3);margin:4px 0 0">
    <b>Вес</b> — Hedge-мультипликатор [0..2], обученный из истории сделок в oi_weights.json.
    1.0=нейтральный, &gt;1=метод исторически давал edge, &lt;1=ослаблен или ненадёжен.
    Наведи мышь на строку — описание метода.
  </p>`;
  return html;
}}

function methodStatsByRegimeToHtml(msr) {{
  if (!msr || !Object.keys(msr).length) return '';
  let html = '';
  for (const [regime, ms] of Object.entries(msr)) {{
    const t = methodStatsToHtml(ms);
    if (!t) continue;
    html += `<div style="margin-top:4px"><b style="color:var(--txt3)">режим: ${{regime}}</b>${{t}}</div>`;
  }}
  return html;
}}

// Бейдж покрытия истории OI по тикеру: есть данные (сколько дней/диапазон) или нет.
function _oiCovBadge(cov) {{
  if (!cov) return '';
  if (!cov.has || !cov.days) {{
    return `<span title="Нет истории FutOI для этого тикера — методы ОИ (OI_SQUEEZE/INST_OI/RETAIL_CONTRA/…) молчат. Собери данные кнопкой «OI Backfill»." style="font-size:8px;padding:0 4px;border:1px solid #a05a2c;border-radius:6px;color:#d08a4a;white-space:nowrap">OI ✗</span>`;
  }}
  const range = (cov.from && cov.to) ? `${{cov.from}} → ${{cov.to}}` : '';
  return `<span title="История FutOI: ${{cov.days}} дн. ${{range}}. Методы ОИ участвуют в сигналах." style="font-size:8px;padding:0 4px;border:1px solid #2c7a4a;border-radius:6px;color:#5cbf85;white-space:nowrap">OI ✓ ${{cov.days}}д</span>`;
}}

// Баннер над таблицей: если у части тикеров нет истории OI — методы ОИ молчат,
// это не «выключено», а нет данных. Подсказываем, как собрать.
function _oiCovBanner(rows) {{
  const withCov = rows.filter(r => r.oi_cov);
  if (!withCov.length) return '';
  const missing = withCov.filter(r => !r.oi_cov.has || !r.oi_cov.days).map(r => r.ticker);
  if (!missing.length) return '';
  const uniq = [...new Set(missing)];
  return `<tr><td colspan="7" style="padding:6px 10px;background:rgba(160,90,44,.12);border-left:2px solid #a05a2c;font-size:11px;color:var(--txt2)">
    ⚠ Методы открытого интереса молчат — нет истории FutOI для: <b>${{uniq.join(', ')}}</b>.
    Это не «выключено», а отсутствие данных. Собери: вкладка <b>Live → OI → «⬇ Запустить загрузку»</b>
    (нужен токен <code>[MOEX] TOKEN</code>, он уже прописан). Живой бот дособирает ОИ сам по мере торговли.
  </td></tr>`;
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
    const clickStyle = 'cursor:pointer;' + (r.trades_list && r.trades_list.length ? 'border-left:2px solid var(--accent);' : '');
    const oiBadge = _oiCovBadge(r.oi_cov);
    html += `<tr onclick="selectTicker('${{r.ticker}}')" title="Кликни — загрузить график" style="${{clickStyle}}"><td><span class="sdot ok"></span>${{r.ticker}} ${{oiBadge}}</td><td>${{r.mode}}</td><td>${{r.n_trades ?? ''}}</td><td>${{winPct}}</td><td>${{avgR}}</td><td>${{exp}}</td><td style="font-size:10px;color:var(--txt3);">${{models}}</td></tr>`;
    if (r.what_if) {{
      const wi = whatIfToHtml(r.what_if);
      if (wi) {{
        html += `<tr><td></td><td colspan="6" style="font-size:10px;color:var(--txt3);">Если бы слушали только модель: ${{wi}}</td></tr>`;
      }}
    }}
    if (r.method_stats) {{
      const mt = methodStatsToHtml(r.method_stats);
      if (mt) {{
        html += `<tr><td></td><td colspan="6"><details style="font-size:11px"><summary style="cursor:pointer;color:var(--txt3)">Attribution по методам</summary>${{mt}}</details></td></tr>`;
      }}
    }}
    if (r.method_stats_by_regime) {{
      const mtr = methodStatsByRegimeToHtml(r.method_stats_by_regime);
      if (mtr) {{
        html += `<tr><td></td><td colspan="6"><details style="font-size:11px"><summary style="cursor:pointer;color:var(--txt3)">Attribution по методам — по режимам</summary>${{mtr}}</details></td></tr>`;
      }}
    }}
    if (r.rejection_stats) {{
      const rs = r.rejection_stats;
      const total = (rs.below_threshold||0) + (rs.methods_disagree||0) + (rs.liquidity||0) + (rs.narrative_blocked||0);
      if (total > 0) {{
        const gateDetails = [
          rs.gate_net_agreement ? `net_agr ${rs.gate_net_agreement}` : '',
          rs.gate_group_diversity ? `groups ${rs.gate_group_diversity}` : '',
          rs.gate_composite_std ? `cmp_std ${rs.gate_composite_std}` : '',
          rs.gate_l2_conflict ? `L2↔L3 ${rs.gate_l2_conflict}` : '',
          rs.gate_m3_veto ? `M3_veto ${rs.gate_m3_veto}` : '',
        ].filter(Boolean).join(' / ');
        html += `<tr><td></td><td colspan="6" style="font-size:10px;color:var(--txt3)">🚫 отклонено баров: порог ${{rs.below_threshold||0}} · методы ${{rs.methods_disagree||0}}${{gateDetails ? ' (' + gateDetails + ')' : ''}} · объём ${{rs.liquidity||0}}${{rs.narrative_blocked ? ' · нарратив ' + rs.narrative_blocked : ''}}</td></tr>`;
      }}
    }}
    if (r.trades_list && r.trades_list.length) {{
      const bw = bestWorstTradesToHtml(r.trades_list);
      const bwm = bestWorstMethodsToHtml(r.method_stats);
      let detailHtml = '';
      detailHtml += `<div style="margin:2px 0 6px"><button onclick="copyTicker('${{r.ticker}}', this)" class="btn-pill btn-xs info" style="font-size:9px;padding:1px 8px" title="Вердикт + точность методов + все сделки со всеми методами">📋 копировать тикер целиком</button></div>`;
      if (bw) detailHtml += `<details style="font-size:11px;margin-bottom:4px"><summary style="cursor:pointer;color:var(--txt3)">▲▼ лучшие / худшие сделки</summary>${{bw}}</details>`;
      if (bwm) detailHtml += `<details style="font-size:11px;margin-bottom:4px"><summary style="cursor:pointer;color:var(--txt3)">▲▼ методы</summary>${{bwm}}</details>`;
      detailHtml += `<details style="font-size:11px"><summary style="cursor:pointer;color:var(--accent)">📈 все сделки (n=${{r.trades_list.length}})</summary>${{tradesListToHtml(r.trades_list, r.win_rate, r.ticker)}}</details>`;
      html += `<tr><td></td><td colspan="6">${{detailHtml}}</td></tr>`;
    }}
  }}
  return html;
}}

// Мини-бар «позиция входа в дневном диапазоне». l1pct ∈ [0..1],
// 0=у лоя, 1=у хая. -1 — нет данных.
function _l1pctBar(l1pct, dir) {{
  if (l1pct < 0) return '<span style="color:var(--txt3)">—</span>';
  const pct = Math.round(l1pct * 100);
  // Покупка в нижней трети — хорошо (зелёный). В верхней трети лонга — плохо (красный).
  const isLong = dir === 'L';
  const good = isLong ? l1pct < 0.35 : l1pct > 0.65;
  const bad  = isLong ? l1pct > 0.65 : l1pct < 0.35;
  const c = good ? '#7dcc7d' : bad ? '#e07070' : 'var(--txt2)';
  // Мини-прогресс-бар: 40px, заливка до l1pct
  const fill = Math.round(l1pct * 38);
  return `<span title="Позиция цены входа в дневном hi-lo: ${{pct}}%. Лонг снизу/шорт сверху = хорошо."
    style="display:inline-flex;align-items:center;gap:3px;color:${{c}}">
    <svg width="38" height="8" style="flex-shrink:0;border-radius:2px;background:var(--bg2)">
      <rect x="0" y="0" width="${{fill}}" height="8" rx="2" fill="${{c}}" opacity="0.7"/>
      <rect x="${{fill}}" y="3" width="2" height="2" rx="1" fill="${{c}}"/>
    </svg>
    <span style="font-size:9px">${{pct}}%</span>
  </span>`;
}}

function tradesListToHtml(trades, overallWr, ticker) {{
  const W = 10;
  let cumR = 0;
  const hasEp = trades.some(t => t.ep && t.ep > 0);
  const colN = hasEp ? 14 : 13;  // число колонок для colspan детальной строки
  let html = '<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:12px;width:100%;border-spacing:0">';
  html += '<tr style="color:var(--txt3);font-size:11px">'
    + '<th style="padding:3px 6px">#</th><th style="padding:3px 8px">Дата</th><th style="padding:3px 6px">Dir</th><th style="padding:3px 6px">Win</th><th style="padding:3px 8px">R</th><th style="padding:3px 8px">cumR</th>'
    + '<th style="padding:3px 8px">MFE%</th><th style="padding:3px 8px">MAE%</th>'
    + '<th style="padding:3px 6px" title="Почему закрыли: тейк / стоп / таймаут">Выход</th>'
    + (hasEp ? '<th title="Вход → Выход / Тейк / Стоп">Вход/Тейк/Стоп</th>' : '')
    + '<th title="Позиция цены входа в дневном хай-лой: 0%=у лоя, 100%=у хая">Hi-Lo%</th>'
    + '<th style="min-width:60px">roll WR(10)</th><th>Топ ЗА</th><th>Топ ПРОТИВ</th></tr>';
  const rollWin = [];
  for (let i = 0; i < trades.length; i++) {{
    const t = trades[i];
    cumR += t.r;
    rollWin.push(t.w);
    if (rollWin.length > W) rollWin.shift();
    const rwr = rollWin.reduce((a, b) => a + b, 0) / rollWin.length;
    const rwrPct = (rwr * 100).toFixed(0) + '%';
    const rwrColor = overallWr !== undefined
      ? (rwr > overallWr ? '#7dcc7d' : rwr < overallWr - 0.1 ? '#e07070' : 'var(--txt3)')
      : 'var(--txt3)';
    const winMark = t.w ? '<span style="color:#7dcc7d">✓</span>' : '<span style="color:#e07070">✗</span>';
    const rColor = t.r > 0 ? '#7dcc7d' : '#e07070';
    const cumRColor = cumR >= 0 ? '#7dcc7d' : '#e07070';
    const mfePct = t.mfe != null ? t.mfe.toFixed(2) + '%' : '—';
    const maePct = t.mae != null ? t.mae.toFixed(2) + '%' : '—';
    const mfeColor = (t.mfe != null && t.mae != null && t.mfe > t.mae) ? '#7dcc7d' : 'var(--txt3)';
    const maeColor = (t.mfe != null && t.mae != null && t.mae > t.mfe) ? '#e07070' : 'var(--txt3)';
    const _xrMap = {{take: 'тейк', stop: 'стоп', timeout: 'таймаут'}};
    const xrTxt = _xrMap[t.xr] || t.xr || '—';
    const xrColor = t.xr === 'take' ? '#7dcc7d' : (t.xr === 'stop' ? '#e07070' : 'var(--txt3)');
    const forStr = t.fa.map(([n, s]) => `<span title="${{_METHOD_RU[n]||n}}">${{n.replace(/_/g,' ').substring(0,10)}} ${{s.toFixed(2)}}</span>`).join(' ');
    const againstStr = t.ag.map(([n, s]) => `<span title="${{_METHOD_RU[n]||n}}">${{n.replace(/_/g,' ').substring(0,10)}} ${{s.toFixed(2)}}</span>`).join(' ');
    // Полный список за/против (все методы) — в тултип ячейки, чтобы видеть целиком.
    const _dir = t.d === 'L' ? 1 : -1;
    const _ms = t.ms || [];
    const allForTitle = 'ЗА (все): ' + (_ms.filter(([n, s]) => s * _dir > 0).map(([n, s]) => (_METHOD_RU[n]||n) + ' ' + s.toFixed(2)).join(', ') || '—');
    const allAgTitle = 'ПРОТИВ (все): ' + (_ms.filter(([n, s]) => s * _dir < 0).map(([n, s]) => (_METHOD_RU[n]||n) + ' ' + s.toFixed(2)).join(', ') || '—');
    const bg = i % 2 === 0 ? 'background:var(--bg2)' : '';
    // Блок цен: ep→xp | tp ✓ | sp ✗
    let priceCell = '';
    if (hasEp && t.ep) {{
      const epStr = t.ep > 0 ? t.ep.toFixed(2) : '—';
      const xpStr = t.xp > 0 ? t.xp.toFixed(2) : '—';
      const tpStr = t.tp > 0 ? `<span style="color:#7dcc7d" title="Тейк">${{t.tp.toFixed(2)}}</span>` : '';
      const spStr = t.sp > 0 ? `<span style="color:#e07070" title="Стоп">${{t.sp.toFixed(2)}}</span>` : '';
      // Расстояние тейк/стоп в %
      const takePct = (t.tp && t.ep) ? Math.abs(t.tp - t.ep)/t.ep*100 : 0;
      const stopPct = (t.sp && t.ep) ? Math.abs(t.sp - t.ep)/t.ep*100 : 0;
      const takePctStr = takePct > 0 ? `<span style="font-size:9px;color:var(--txt3)">+${{takePct.toFixed(2)}}%</span>` : '';
      const stopPctStr = stopPct > 0 ? `<span style="font-size:9px;color:var(--txt3)">-${{stopPct.toFixed(2)}}%</span>` : '';
      priceCell = `<td style="padding:1px 4px;white-space:nowrap;font-size:9px;color:var(--txt2)">
        ${{epStr}}→${{xpStr}}<br>
        ${{tpStr}} ${{takePctStr}} / ${{spStr}} ${{stopPctStr}}
      </td>`;
    }} else if (hasEp) {{
      priceCell = '<td></td>';
    }}
    const l1bar = _l1pctBar(t.l1pct != null ? t.l1pct : -1, t.d);
    // Формат даты: YYYY-MM-DD HH:MM → DD.MM HH:MM (короче, читаемее)
    const dtParts = (t.t || '').split(' ');
    const datePart = dtParts[0] ? dtParts[0].split('-').slice(1).reverse().join('.') : '—';
    const timePart = dtParts[1] ? dtParts[1].substring(0,5) : '';
    const dtFmt = datePart + (timePart ? ' ' + timePart : '');
    const td = s => `<td style="padding:2px 8px;${s||''}">`; const _td = '</td>';
    // Регистрируем сделку — для раскрытия «все методы» и копирования по одной.
    const uid = (ticker || 'tk') + '_' + i;
    _tradeReg[uid] = {{ticker: ticker || '', t, i}};
    const nMs = (t.ms || []).length;
    html += `<tr style="${{bg}}">
      ${td('color:var(--txt3);white-space:nowrap')}${{i+1}} <button onclick="toggleTradeMethods('${{uid}}', this)" title="Показать все ${{nMs}} методов сделки" style="font-size:8px;padding:0 4px;border:1px solid var(--border2);border-radius:3px;background:transparent;color:var(--txt3);cursor:pointer">▾ методы</button>${_td}
      ${td('white-space:nowrap;letter-spacing:.01em')}${{dtFmt}}${_td}
      ${td('font-weight:600')}${{t.d}}${_td}${td('')}${{winMark}}${_td}
      ${td('color:'+rColor+';font-weight:600')}${{t.r.toFixed(2)}}${_td}
      ${td('color:'+cumRColor)}${{cumR.toFixed(2)}}${_td}
      ${td('color:'+mfeColor)}${{mfePct}}${_td}
      ${td('color:'+maeColor)}${{maePct}}${_td}
      ${td('color:'+xrColor+';font-size:10px;white-space:nowrap')}${{xrTxt}}${_td}
      ${{priceCell}}
      <td style="padding:2px 4px">${{l1bar}}</td>
      ${td('color:'+rwrColor)}${{rwrPct}}${_td}
      <td style="padding:2px 8px;color:var(--txt3);max-width:160px;white-space:nowrap;overflow:hidden;cursor:help" title="${{allForTitle}}">${{forStr}}</td>
      <td style="padding:2px 8px;color:var(--txt3);max-width:160px;white-space:nowrap;overflow:hidden;cursor:help" title="${{allAgTitle}}">${{againstStr}}</td>
    </tr>
    <tr id="tmrow_${{uid}}" style="display:none;${{bg}}">
      <td colspan="${{colN}}" style="padding:4px 10px;border-bottom:1px solid var(--border2)">
        ${{_tradeFullMethodsHtml(t)}}
        <button onclick="copyTrade('${{uid}}', this)" class="btn-pill btn-xs info" style="font-size:9px;padding:1px 8px;margin-top:2px">📋 копировать сделку</button>
      </td>
    </tr>`;
  }}
  html += '</table></div>';
  return html;
}}

function bestWorstTradesToHtml(trades, n=5) {{
  if (!trades || !trades.length) return '';
  const sorted = [...trades].sort((a, b) => b.r - a.r);
  const best = sorted.slice(0, n);
  const worst = sorted.slice(-n).reverse();
  const row = (t, i) => {{
    const rColor = t.r > 0 ? '#7dcc7d' : '#e07070';
    const winMark = t.w ? '✓' : '✗';
    const mfe = t.mfe != null ? t.mfe.toFixed(2) + '%' : '';
    const mae = t.mae != null ? t.mae.toFixed(2) + '%' : '';
    return `<tr><td style="color:var(--txt3);padding:1px 4px">${{i+1}}</td><td style="white-space:nowrap;padding:1px 4px">${{t.t}}</td><td style="padding:1px 4px">${{t.d}}</td><td style="padding:1px 4px">${{winMark}}</td><td style="color:${{rColor}};padding:1px 4px;font-weight:600">${{t.r.toFixed(2)}}R</td><td style="color:#7dcc7d;padding:1px 4px">${{mfe}}</td><td style="color:#e07070;padding:1px 4px">${{mae}}</td></tr>`;
  }};
  const tblStyle = 'border-collapse:collapse;font-size:10px;';
  const hdr = '<tr style="color:var(--txt3)"><th></th><th>Дата</th><th>Dir</th><th>W</th><th>R</th><th>MFE</th><th>MAE</th></tr>';
  return `<div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:4px;">
    <div><div style="font-size:10px;color:var(--pos);margin-bottom:2px;">▲ лучшие ${{best.length}}</div><table style="${{tblStyle}}">${{hdr}}${{best.map(row).join('')}}</table></div>
    <div><div style="font-size:10px;color:var(--neg);margin-bottom:2px;">▼ худшие ${{worst.length}}</div><table style="${{tblStyle}}">${{hdr}}${{worst.map(row).join('')}}</table></div>
  </div>`;
}}

function bestWorstMethodsToHtml(methodStats) {{
  if (!methodStats) return '';
  const rows = Object.entries(methodStats)
    .filter(([, s]) => s.agree_n >= 3 || s.disagree_n >= 3)
    .map(([name, s]) => {{
      const fwr = s.agree_win_rate != null ? s.agree_win_rate : 0.5;
      const awr = s.disagree_win_rate != null ? s.disagree_win_rate : 0.5;
      return {{name, fwr, awr, fn: s.agree_n||0, an: s.disagree_n||0}};
    }});
  if (!rows.length) return '';
  const byFor = [...rows].filter(r=>r.fn>=3).sort((a,b)=>b.fwr-a.fwr);
  const byAgainst = [...rows].filter(r=>r.an>=3).sort((a,b)=>b.awr-a.awr);
  const best = byFor.slice(0,5);
  const worst = byFor.slice(-5).reverse();
  const contra = byAgainst.filter(r=>r.awr>0.6).slice(0,4);
  const mRow = (r) => {{
    const c = r.fwr >= 0.6 ? '#7dcc7d' : r.fwr <= 0.45 ? '#e07070' : 'var(--txt2)';
    return `<tr><td style="padding:1px 6px;white-space:nowrap;font-size:10px">${{r.name.replace(/_/g,' ')}}</td><td style="padding:1px 6px;color:${{c}};font-size:10px">${{(r.fwr*100).toFixed(0)}}% n=${{r.fn}}</td></tr>`;
  }};
  let html = '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:4px;">';
  if (best.length) html += `<div><div style="font-size:10px;color:var(--pos);margin-bottom:2px;">▲ лучшие методы (за)</div><table style="border-collapse:collapse">${{best.map(mRow).join('')}}</table></div>`;
  if (worst.length) html += `<div><div style="font-size:10px;color:var(--neg);margin-bottom:2px;">▼ худшие методы (за)</div><table style="border-collapse:collapse">${{worst.map(mRow).join('')}}</table></div>`;
  if (contra.length) html += `<div><div style="font-size:10px;color:var(--warn,#f5a623);margin-bottom:2px;">↻ контрарные (против wins)</div><table style="border-collapse:collapse">${{contra.map(r=>{{
    return `<tr><td style="padding:1px 6px;white-space:nowrap;font-size:10px">${{r.name.replace(/_/g,' ')}}</td><td style="padding:1px 6px;color:var(--warn,#f5a623);font-size:10px">${{(r.awr*100).toFixed(0)}}% n=${{r.an}}</td></tr>`;
  }}).join('')}}</table></div>`;
  html += '</div>';
  return html;
}}

// ===== Глобальная статистика методов =====

// Полный каталог методов. Единый источник; держать в синхроне с ALL_METHOD_NAMES
// (oi_composite_strategy.py). Строка: [группа, имя, рус.подпись, переключаемый].
// переключаемый=1 → checkbox + кнопка инверсии (set_disabled_methods/
// set_inverted_methods их видят). OI-методы теперь тоже переключаемы —
// их скоры пропускаются через тот же гейт в стратегии (данные идут из
// воркера). переключаемый=0 → метод считается, но выключить/инвертировать
// отсюда нельзя: микроструктура (tradestats) молчит без данных, структурные
// (MTF) считаются отдельно, а M1/M2/M3 — диагностика (в живой композит не
// входят). Показаны, чтобы список был полным.
const _METHOD_CATALOG = [
  ["Тренд / MA","PRICE_TREND","тренд цены (линрег)",1],
  ["Тренд / MA","TREND_QUALITY","качество тренда (TQI)",1],
  ["Тренд / MA","ADAPTIVE_MA","отклонение от KAMA",1],
  ["Тренд / MA","ZLEMA_SIGNAL","ZLEMA (без лага)",1],
  ["Тренд / MA","T3_SIGNAL","T3-скользящая",1],
  ["Тренд / MA","MAMA_FAMA","MAMA / FAMA",1],
  ["Тренд / MA","ALLIGATOR","аллигатор Вильямса",1],
  ["Тренд / MA","MA_ENVELOPE","конверт скользящей",1],
  ["Тренд / MA","MA_TENSION","натяжение к MA",1],
  ["Тренд / MA","ICHIMOKU_SIGNAL","облако Ишимоку",1],
  ["Объём","VOL_MOMENTUM","объём × направление",1],
  ["Объём","KLINGER","осциллятор Клингера",1],
  ["Объём","VZO","Volume Zone Oscillator",1],
  ["Объём","TWIGGS","Twiggs Money Flow",1],
  ["Объём","CUMUL_DELTA","кумулятивная дельта",1],
  ["Объём","AMT_POC","POC / профиль объёма",1],
  ["Объём","VSA","VSA (объём-спред-анализ)",1],
  ["Объём","VSA_ABSORPTION","VSA-поглощение",1],
  ["Осцилляторы / возврат","VWAP_SIGNAL","отклонение от VWAP",1],
  ["Осцилляторы / возврат","RMI","Relative Momentum Index",1],
  ["Осцилляторы / возврат","FISHER_RSI","преобразование Фишера от RSI",1],
  ["Осцилляторы / возврат","ZSCORE","z-score (возврат к среднему)",1],
  ["Осцилляторы / возврат","RSI_DIVERGENCE","дивергенция RSI",1],
  ["Осцилляторы / возврат","ADX_DI_CONVERGENCE","ADX/DI конвергенция",1],
  ["Осцилляторы / возврат","ULT_OSC_DISAGREEMENT","Ultimate Osc расхождение",1],
  ["Осцилляторы / возврат","DONCHIAN","канал Дончиана",1],
  ["Осцилляторы / возврат","BB_KELTNER_SQUEEZE","сжатие BB / Keltner",1],
  ["Циклы (Ehlers/DSP)","SINEWAVE_SIGNAL","синусоида Ehlers (EBSW)",1],
  ["Циклы (Ehlers/DSP)","EHLERS_MODE","режим тренд/цикл (Ehlers)",1],
  ["Циклы (Ehlers/DSP)","CYBER_PHASE","фаза Cyber Cycle",1],
  ["Циклы (Ehlers/DSP)","SSA_SIGNAL","SSA-тренд (сингулярный спектр)",1],
  ["Свечи / паттерны","CANDLE_PATTERN","свечные паттерны",1],
  ["Свечи / паттерны","TALIB_ANTISIGNAL","TA-Lib анти-паттерны (fade)",1],
  ["Свечи / паттерны","WICK_REJECTION","отбой фитилём",1],
  ["Свечи / паттерны","TRIANGLE","треугольник",1],
  ["Свечи / паттерны","BS_PRESSURE","давление тела свечи",1],
  ["Импульс / движение","PRICE_ACCEL","ускорение цены",1],
  ["Импульс / движение","IMPULSE_PULLBACK","откат от импульса",1],
  ["Импульс / движение","WANING_IMPULSES","затухание импульсов",1],
  ["Импульс / движение","CASCADE","каскад (лавина)",1],
  ["Импульс / движение","VOL_COMPRESSION","сжатие волатильности",1],
  ["Импульс / движение","FALSE_BREAKOUT","ложный пробой",1],
  ["Импульс / движение","LEVEL_ABSORPTION","поглощение на уровне",1],
  ["Импульс / движение","ATR_EXHAUSTION","истощение по ATR",1],
  ["Фракталы / матстат","FRACTAL","фрактал (FDI/Hurst/PFE)",1],
  ["Фракталы / матстат","ENTROPY","энтропия движения",1],
  ["Фракталы / матстат","HAWKES_SIGNAL","процесс Хоукса",1],
  ["Фракталы / матстат","NADARAYA_WATSON","ядерная регрессия",1],
  ["Фракталы / матстат","FRACTIONAL_DIFF","дробное дифференцирование",1],
  ["Уровни / SMC","LEVEL_QUALITY","качество уровня (3 из 5)",1],
  ["Уровни / SMC","FVG","гэп справедливой цены (FVG)",1],
  ["Уровни / SMC","ORDER_BLOCK","ордер-блок",1],
  ["Уровни / SMC","LIQUIDITY_SWEEP","снятие ликвидности",1],
  ["Структура (MTF) — не выключается","LEVEL_CONTEXT","контекст уровней",0],
  ["Структура (MTF) — не выключается","MKT_STRUCTURE","структура рынка (HH/HL)",0],
  ["Структура (MTF) — не выключается","SPRING","пружина Вайкоффа",0],
  ["Открытый интерес (FutOI)","OI_SQUEEZE","сквиз открытого интереса",1],
  ["Открытый интерес (FutOI)","INST_OI","нетто-позиция юрлиц",1],
  ["Открытый интерес (FutOI)","RETAIL_CONTRA","контр-сигнал физлиц",1],
  ["Открытый интерес (FutOI)","DELTA_QUADRANT","квадрант дельты ОИ",1],
  ["Открытый интерес (FutOI)","OI_ABSORPTION","поглощение по ОИ",1],
  ["Микроструктура (tradestats) — провайдер","BS_PRESSURE_TS","давление сделок",0],
  ["Микроструктура (tradestats) — провайдер","AGGRESSOR_FLOW","поток агрессора",0],
  ["Микроструктура (tradestats) — провайдер","LARGE_IMPACT","перекос крупных сделок",0],
  ["Микроструктура (tradestats) — провайдер","VWAP_SIGNAL_TS","внутридневной VWAP",0],
  ["Микроструктура (tradestats) — провайдер","VOL_MOMENTUM_TS","аномальный объём",0],
  ["Микроструктура (tradestats) — провайдер","OB_IMBALANCE","дисбаланс стакана",0],
  ["Микроструктура (tradestats) — провайдер","CANCEL_SIGNAL","отмены заявок",0],
  ["Прочее","CHANGE_POINT","точка излома (CUSUM/PELT)",0],
  ["Прочее","MULTI_TICKER","межинструментальный",0],
  ["Прочее","INDEX_CONTEXT","индекс к своим уровням",0],
  ["Диагностика — в композит НЕ входят","M1_CLUSTER","M1 (кластерная модель)",0],
  ["Диагностика — в композит НЕ входят","M2_CLUSTER","M2 (кластерная модель)",0],
  ["Диагностика — в композит НЕ входят","M3_CLUSTER","M3 (кластерная модель)",0]
];
const _ALL_METHODS = _METHOD_CATALOG.filter(r => r[3]).map(r => r[1]);
// имя метода → русская подпись (для тултипов в атрибуции сделок)
const _METHOD_RU = {{}};
_METHOD_CATALOG.forEach(r => {{ _METHOD_RU[r[1]] = r[2]; }});

// Анти-дрейф: JS-каталог методов — не единый источник, поэтому сверяем его с
// эталоном из Python (ALL_METHOD_NAMES, /api/method_catalog). Разъехалось —
// громко в консоль + красный баннер, чтобы рассинхрон не прошёл незаметно.
window.addEventListener('load', function() {{
  fetch('/api/method_catalog').then(r => r.json()).then(d => {{
    const py = new Set(d.names || []);
    const js = new Set(_METHOD_CATALOG.map(r => r[1]));
    const missingInJs = [...py].filter(n => !js.has(n));
    const extraInJs = [...js].filter(n => !py.has(n));
    if (missingInJs.length || extraInJs.length) {{
      console.warn('Каталог методов РАЗЪЕХАЛСЯ с Python (ALL_METHOD_NAMES):',
        {{нет_в_UI: missingInJs, лишние_в_UI: extraInJs}});
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#b91c1c;color:#fff;font:12px/1.4 monospace;padding:6px 12px;';
      bar.textContent = '⚠ Каталог методов разъехался с Python — нет в UI: [' +
        missingInJs.join(', ') + '] | лишние в UI: [' + extraInJs.join(', ') + ']';
      document.body.appendChild(bar);
    }}
  }}).catch(() => {{}});
}});

function initMethodCheckboxes() {{
  const box = document.getElementById('method_checkboxes');
  if (!box || box.children.length) return;
  let curGroup = '';
  for (const row of _METHOD_CATALOG) {{
    const grp = row[0], name = row[1], ru = row[2], toggl = row[3];
    if (grp !== curGroup) {{
      curGroup = grp;
      const h = document.createElement('div');
      h.textContent = grp;
      h.style.cssText = 'width:100%;font-size:9px;font-weight:600;color:var(--txt3);text-transform:uppercase;letter-spacing:.4px;margin:6px 0 2px;border-bottom:1px solid var(--border2);padding-bottom:1px;';
      box.appendChild(h);
    }}
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:1px;min-width:155px;';
    const lbl = document.createElement('label');
    lbl.style.cssText = 'display:flex;align-items:center;gap:3px;font-size:10px;color:var(--txt2);flex:1;min-width:0;overflow:hidden;cursor:' + (toggl ? 'pointer' : 'default') + ';' + (toggl ? '' : 'opacity:.6;');
    const cap = name + ' — ' + ru;
    lbl.title = cap;  // полное имя в тултипе — подпись усекается многоточием
    const capSpan = document.createElement('span');
    capSpan.textContent = cap;
    capSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;';
    if (toggl) {{
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = name; cb.id = 'dm_' + name;
      cb.onchange = () => {{ updateDisabledCount(); renderGlobalMethodStats(); }};
      lbl.append(cb, capSpan);
      const inv = document.createElement('button');
      inv.textContent = '↔'; inv.title = 'Использовать как контр-индикатор (инвертировать скор)';
      inv.id = 'inv_' + name;
      inv.style.cssText = 'font-size:9px;padding:0 5px;border-radius:3px;border:1px solid var(--border2);background:transparent;color:var(--txt3);cursor:pointer;line-height:14px;flex:none;';
      inv.onclick = () => {{ toggleInvertMethod(name); renderGlobalMethodStats(); }};
      wrap.append(lbl, inv);
    }} else {{
      lbl.append(capSpan);
      const tag = document.createElement('span');
      tag.textContent = 'инфо';
      tag.title = 'Метод считается, но отключить/инвертировать его отсюда нельзя';
      tag.style.cssText = 'font-size:8px;padding:0 4px;border-radius:3px;border:1px solid var(--border2);color:var(--txt3);line-height:14px;flex:none;';
      wrap.append(lbl, tag);
    }}
    box.appendChild(wrap);
  }}
}}

function toggleMethodDisable() {{
  initMethodCheckboxes();
  refreshMethodPresets();
  const p = document.getElementById('method_disable_panel');
  p.style.display = p.style.display === 'none' ? '' : 'none';
}}

// Диагностика адаптивной калибровки на реальных данных (method_params.json).
function loadMethodCalibration() {{
  const panel = document.getElementById('method_calib_panel');
  panel.style.display = '';
  panel.innerHTML = '<span style="font-size:10px;color:var(--txt3)">загрузка…</span>';
  fetch('/api/method_calibration').then(r => r.json()).then(d => {{
    if (d.error) {{ panel.innerHTML = `<span style="font-size:11px;color:var(--neg)">${{d.error}}</span>`; return; }}
    const tickers = d.tickers || {{}};
    const names = Object.keys(tickers).sort();
    if (!names.length) {{ panel.innerHTML = '<span style="font-size:11px;color:var(--txt3)">пусто — бот ещё не калибровал</span>'; return; }}
    let html = '';
    for (const tk of names) {{
      const rows = tickers[tk] || [];
      const nAd = rows.filter(r => r.adapted).length;
      html += `<div style="margin:8px 0 2px;font-size:11px;font-weight:700;color:var(--txt2)">${{tk}} <span style="color:var(--txt3);font-weight:400">— адаптировано ${{nAd}}/${{rows.length}}</span></div>`;
      html += '<table style="border-collapse:collapse;width:100%;max-width:640px;font-size:10px"><tr style="color:var(--txt3)">'
            + '<th style="text-align:left;padding:1px 6px">метод</th><th style="padding:1px 6px">выбор</th>'
            + '<th style="padding:1px 6px" title="ожидаемая доходность на сигнал, б.п.">edge</th>'
            + '<th style="padding:1px 6px">классика</th><th style="padding:1px 6px" title="улучшение над классикой">Δ</th>'
            + '<th style="padding:1px 6px" title="усадка к классике 0..1">λ</th>'
            + '<th style="padding:1px 6px" title="доля фолдов, где выбранный обошёл классику">согл.</th>'
            + '<th style="padding:1px 6px">H</th></tr>';
      for (const r of rows) {{
        const bp = v => v === null || v === undefined ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1);
        const dCol = r.improve_bp == null ? 'var(--txt3)' : r.improve_bp > 0 ? 'var(--pos)' : 'var(--neg)';
        const lbl = r.adapted
          ? `<span style="color:var(--pos)">${{r.label}}${{r.use_alt ? ' ↔alt' : ''}}</span>`
          : '<span style="color:var(--txt3)">default</span>';
        html += `<tr style="${{r.adapted ? '' : 'opacity:.5'}}">`
              + `<td style="padding:1px 6px">${{r.method.replace(/_/g,' ')}}</td>`
              + `<td style="padding:1px 6px">${{lbl}}</td>`
              + `<td style="text-align:right;padding:1px 6px">${{bp(r.edge_bp)}}</td>`
              + `<td style="text-align:right;padding:1px 6px;color:var(--txt3)">${{bp(r.edge_classic_bp)}}</td>`
              + `<td style="text-align:right;padding:1px 6px;color:${{dCol}}">${{bp(r.improve_bp)}}</td>`
              + `<td style="text-align:right;padding:1px 6px">${{r.adapted ? (r.shrink||0).toFixed(2) : '—'}}</td>`
              + `<td style="text-align:right;padding:1px 6px">${{r.adapted ? Math.round((r.consistency||0)*100)+'%' : '—'}}</td>`
              + `<td style="text-align:right;padding:1px 6px;color:var(--txt3)">${{r.horizon||''}}</td></tr>`;
      }}
      html += '</table>';
    }}
    panel.innerHTML = html;
  }}).catch(e => {{ panel.innerHTML = `<span style="font-size:11px;color:var(--neg)">${{e}}</span>`; }});
}}

function clearDisabledMethods() {{
  document.querySelectorAll('#method_checkboxes input[type=checkbox]').forEach(cb => cb.checked = false);
  document.querySelectorAll('#method_checkboxes button[id^=inv_]').forEach(b => {{
    b.style.background = 'transparent'; b.style.color = 'var(--txt3)';
    b.dataset.active = '';
  }});
  updateDisabledCount();
  renderGlobalMethodStats();
}}

function toggleInvertMethod(name) {{
  initMethodCheckboxes();
  const btn = document.getElementById('inv_' + name);
  if (!btn) return;
  const active = btn.dataset.active === '1';
  btn.dataset.active = active ? '' : '1';
  btn.style.background = active ? 'transparent' : '#6b4c00';
  btn.style.color = active ? 'var(--txt3)' : '#f0a030';
  btn.style.borderColor = active ? 'var(--border2)' : '#f0a030';
  // снять "отключён" если включаем инверсию
  if (!active) {{
    const cb = document.getElementById('dm_' + name);
    if (cb) cb.checked = false;
  }}
  updateDisabledCount();
}}

function getInvertedMethods() {{
  return Array.from(document.querySelectorAll('#method_checkboxes button[id^=inv_]'))
    .filter(b => b.dataset.active === '1')
    .map(b => b.id.replace('inv_', ''));
}}

let _methodToggleSaveTimer = null;
function updateDisabledCount() {{
  const nd = getDisabledMethods().length;
  const ni = getInvertedMethods().length;
  const el = document.getElementById('disabled_count');
  const parts = [];
  if (nd) parts.push(`откл: ${{nd}}`);
  if (ni) parts.push(`↔ инв: ${{ni}}`);
  el.textContent = parts.join(' · ');
  // Автосохранение на сервер — переживает перезагрузку страницы (см.
  // restoreMethodToggleState). Дебаунс, чтобы серия быстрых кликов (напр.
  // autoDisableWeakMethods по 10+ методам подряд) не слала 10+ запросов.
  clearTimeout(_methodToggleSaveTimer);
  _methodToggleSaveTimer = setTimeout(() => {{
    fetch('/api/method_toggle_state_save', {{
      method: 'POST', headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{disabled: getDisabledMethods(), inverted: getInvertedMethods()}}),
    }}).catch(() => {{}});
  }}, 400);
}}

function getDisabledMethods() {{
  return Array.from(document.querySelectorAll('#method_checkboxes input[type=checkbox]:checked')).map(cb => cb.value);
}}

// Восстанавливает вкл/выкл методов из последнего автосохранённого состояния —
// вызывается один раз при загрузке страницы (DOMContentLoaded), чтобы верхняя
// панель сразу показывала то, что реально включено в этой сессии, а не пустой
// список до первого клика по "показать/скрыть".
function restoreMethodToggleState() {{
  fetch('/api/method_toggle_state').then(r => r.json()).then(st => {{
    initMethodCheckboxes();
    (st.disabled || []).forEach(name => {{
      const cb = document.getElementById('dm_' + name);
      if (cb) cb.checked = true;
    }});
    (st.inverted || []).forEach(name => {{
      const btn = document.getElementById('inv_' + name);
      if (btn && btn.dataset.active !== '1') toggleInvertMethod(name);
    }});
    updateDisabledCount();
  }}).catch(() => {{}});
}}

// ── Пресеты методов (data/method_presets.json на сервере) ──────────────────
let _methodPresets = {{}};

function refreshMethodPresets() {{
  fetch('/api/method_presets').then(r => r.json()).then(d => {{
    _methodPresets = d || {{}};
    const sel = document.getElementById('method_preset_select');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">— загрузить пресет —</option>';
    Object.keys(_methodPresets).sort().forEach(name => {{
      const o = document.createElement('option');
      o.value = name; o.textContent = name;
      o.title = (_methodPresets[name] && _methodPresets[name].description) || '';
      sel.appendChild(o);
    }});
    if (cur && _methodPresets[cur]) sel.value = cur;
  }}).catch(() => {{}});
}}

function saveMethodPreset() {{
  const name = (prompt('Имя пресета:') || '').trim();
  if (!name) return;
  const body = JSON.stringify({{name: name, disabled: getDisabledMethods(), inverted: getInvertedMethods()}});
  fetch('/api/method_presets_save', {{method: 'POST', headers: {{'Content-Type': 'application/json'}}, body: body}})
    .then(r => r.json()).then(d => {{
      const msg = document.getElementById('method_preset_msg');
      if (d.error) {{ if (msg) msg.textContent = 'ошибка: ' + d.error; return; }}
      if (msg) msg.textContent = 'сохранён: ' + name;
      refreshMethodPresets();
      const sel = document.getElementById('method_preset_select');
      if (sel) sel.value = name;
    }}).catch(() => {{}});
}}

function applyMethodPreset() {{
  const sel = document.getElementById('method_preset_select');
  if (!sel || !sel.value) return;
  const p = _methodPresets[sel.value];
  if (!p) return;
  initMethodCheckboxes();
  clearDisabledMethods();
  (p.disabled || []).forEach(name => {{
    const cb = document.getElementById('dm_' + name);
    if (cb) cb.checked = true;
  }});
  (p.inverted || []).forEach(name => {{
    const btn = document.getElementById('inv_' + name);
    if (btn && btn.dataset.active !== '1') toggleInvertMethod(name);
  }});
  updateDisabledCount();
  renderGlobalMethodStats();
  const msg = document.getElementById('method_preset_msg');
  if (msg) msg.textContent = 'применён: ' + sel.value;
}}

function deleteMethodPreset() {{
  const sel = document.getElementById('method_preset_select');
  if (!sel || !sel.value) return;
  const name = sel.value;
  if (!confirm('Удалить пресет «' + name + '»?')) return;
  fetch('/api/method_presets_delete', {{method: 'POST', headers: {{'Content-Type': 'application/json'}}, body: JSON.stringify({{name: name}})}})
    .then(() => {{
      const msg = document.getElementById('method_preset_msg');
      if (msg) msg.textContent = 'удалён: ' + name;
      refreshMethodPresets();
    }}).catch(() => {{}});
}}

// Агрегирует method_stats по всем строкам _backtestRows и рисует глобальную таблицу.
// Показываем ВЕСЬ каталог методов (_METHOD_CATALOG), а не только те, что набрали
// ≥5 сделок — иначе половина списка «исчезает» и непонятно, что вообще считалось.
// Плюс отдельный блок «почему входим / почему выходим»: агрегат драйверов входа
// (топ-методы «за» на входе) и распределение причин выхода (тейк/стоп/таймаут).
function renderGlobalMethodStats() {{
  const agg = {{}};
  for (const r of _backtestRows) {{
    if (!r.method_stats) continue;
    for (const [name, s] of Object.entries(r.method_stats)) {{
      if (!agg[name]) agg[name] = {{an: 0, aw: 0, dn: 0, dw: 0}};
      agg[name].an += s.agree_n || 0;
      agg[name].aw += s.agree_win || 0;
      agg[name].dn += s.disagree_n || 0;
      agg[name].dw += s.disagree_win || 0;
    }}
  }}

  // ── Агрегат входов/выходов из компактных trades_list ──
  const exitAgg = {{}};      // xr -> {{n, win}}
  const entryDrivers = {{}};  // method -> {{n, win}} по появлению в топ-«за» на входе
  let nTrades = 0;
  for (const r of _backtestRows) {{
    if (!r.trades_list) continue;
    for (const t of r.trades_list) {{
      nTrades++;
      const xr = t.xr || '—';
      if (!exitAgg[xr]) exitAgg[xr] = {{n: 0, win: 0}};
      exitAgg[xr].n++; exitAgg[xr].win += (t.w ? 1 : 0);
      for (const pair of (t.fa || [])) {{
        const nm = pair[0];
        if (!entryDrivers[nm]) entryDrivers[nm] = {{n: 0, win: 0}};
        entryDrivers[nm].n++; entryDrivers[nm].win += (t.w ? 1 : 0);
      }}
    }}
  }}

  const el = document.getElementById('global_method_stats');
  const hasAny = Object.keys(agg).length || nTrades;
  if (!hasAny) {{ el.style.display = 'none'; return; }}

  // Все методы из каталога + подхватываем те, что вдруг есть в agg, но выпали из каталога.
  const catNames = _METHOD_CATALOG.map(r => r[1]);
  const allNames = catNames.slice();
  for (const nm of Object.keys(agg)) if (!allNames.includes(nm)) allNames.push(nm);

  const rows = allNames.map(name => {{
    const s = agg[name] || {{an: 0, aw: 0, dn: 0, dw: 0}};
    const fwr = s.an > 0 ? s.aw / s.an : null;
    const awr = s.dn > 0 ? s.dw / s.dn : null;
    return {{name, fwr, awr, fn: s.an, dn: s.dn, tot: s.an + s.dn}};
  }});
  // Сортировка: сначала методы с данными (по чистому% убыв.), «немые» — в конце.
  rows.sort((a, b) => {{
    if ((a.tot > 0) !== (b.tot > 0)) return a.tot > 0 ? -1 : 1;
    const na = a.fwr != null ? (a.awr != null ? a.fwr - a.awr : a.fwr - 0.5) : -99;
    const nb = b.fwr != null ? (b.awr != null ? b.fwr - b.awr : b.fwr - 0.5) : -99;
    return nb - na;
  }});

  const pct = v => v != null ? (v * 100).toFixed(0) + '%' : '—';
  const col = v => v == null ? 'var(--txt3)' : v >= 0.60 ? '#7dcc7d' : v <= 0.42 ? '#e07070' : 'var(--txt2)';
  const netCol = v => v == null ? 'var(--txt3)' : v > 0.08 ? '#7dcc7d' : v < -0.05 ? '#e07070' : 'var(--txt2)';
  const netPct = v => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(0) + '%';

  const trs = rows.map(r => {{
    const disabled = getDisabledMethods().includes(r.name);
    const inverted = getInvertedMethods().includes(r.name);
    const mute = r.tot === 0;                 // метод ни разу не высказался
    const lowN = !mute && r.tot < 5;          // мало сделок — цифры ненадёжны
    const net = (r.fwr != null && r.awr != null) ? r.fwr - r.awr : (r.fwr != null ? r.fwr - 0.5 : null);
    const rowStyle = disabled ? 'opacity:.45;' : inverted ? 'background:rgba(107,76,0,.15);' : mute ? 'opacity:.5;' : '';
    const nStyle = lowN ? 'color:#c99a4a' : 'color:var(--txt3)';
    return `<tr style="${{rowStyle}}">
      <td style="padding:2px 8px;font-size:10px;white-space:nowrap;">${{r.name.replace(/_/g,' ')}}${{disabled ? ' <span style="color:#e07070;font-size:9px;font-weight:600;">⛔ выкл (для след. прогона)</span>' : ''}}${{inverted ? ' <span style="color:#f0a030;font-size:9px;">↔</span>' : ''}}${{mute ? ' <span style="color:var(--txt3);font-size:8px;">нет сделок</span>' : ''}}</td>
      <td style="padding:2px 8px;font-size:10px;color:${{col(r.fwr)}};text-align:right;">${{pct(r.fwr)}} <span style="${{nStyle}}">n=${{r.fn}}</span></td>
      <td style="padding:2px 8px;font-size:10px;color:${{col(r.awr)}};text-align:right;">${{pct(r.awr)}} <span style="${{nStyle}}">n=${{r.dn}}</span></td>
      <td style="padding:2px 8px;font-size:10px;color:${{netCol(net)}};text-align:right;font-weight:600;">${{netPct(net)}}</td>
      <td style="padding:2px 4px;display:flex;gap:3px;">
        <button class="btn-pill btn-xs ghost" onclick="toggleMethodInRun('${{r.name}}')" title="${{disabled ? 'Сейчас: выключен. Нажми, чтобы включить в следующем прогоне' : 'Сейчас: включён. Нажми, чтобы выключить в следующем прогоне'}}" style="font-size:9px;padding:1px 6px;${{disabled ? 'color:#7dcc7d;' : 'color:#e07070;'}}">${{disabled ? '▶ включить' : '⏸ выключить'}}</button>
        <button class="btn-pill btn-xs ghost" onclick="toggleInvertMethodFromStats('${{r.name}}')" style="font-size:9px;padding:1px 6px;color:${{inverted ? '#f0a030' : 'var(--txt3)'}};">↔</button>
      </td>
    </tr>`;
  }}).join('');
  const nShown = rows.filter(r => r.tot > 0).length;

  // ── Блок «почему входим» ──
  const XR_LABELS = {{take: '✅ тейк', stop: '🛑 стоп', timeout: '⏱ таймаут'}};
  const drv = Object.entries(entryDrivers).sort((a, b) => b[1].n - a[1].n).slice(0, 10);
  const drvHtml = drv.length ? drv.map(([nm, s]) => {{
    const wr = s.n > 0 ? s.win / s.n : null;
    return `<span style="display:inline-block;font-size:10px;padding:2px 7px;margin:2px;border:1px solid var(--border2);border-radius:10px;">`
      + `${{nm.replace(/_/g,' ')}} <span style="color:var(--txt3)">×${{s.n}}</span> `
      + `<span style="color:${{col(wr)}}">${{pct(wr)}}</span></span>`;
  }}).join('') : '<span style="color:var(--txt3);font-size:10px;">нет данных о входах</span>';

  // ── Блок «почему выходим» ──
  const xrOrder = ['take', 'stop', 'timeout'];
  const xrRank = k => {{ const i = xrOrder.indexOf(k); return i < 0 ? 99 : i; }};
  const xrKeys = Object.keys(exitAgg).sort((a, b) => xrRank(a) - xrRank(b) || exitAgg[b].n - exitAgg[a].n);
  const exitHtml = nTrades ? xrKeys.map(k => {{
    const s = exitAgg[k];
    const share = nTrades > 0 ? s.n / nTrades : 0;
    const wr = s.n > 0 ? s.win / s.n : null;
    return `<span style="display:inline-block;font-size:10px;padding:2px 7px;margin:2px;border:1px solid var(--border2);border-radius:10px;">`
      + `${{XR_LABELS[k] || k}} <span style="color:var(--txt3)">${{(share*100).toFixed(0)}}% · n=${{s.n}}</span> `
      + `<span style="color:${{col(wr)}}">win ${{pct(wr)}}</span></span>`;
  }}).join('') : '<span style="color:var(--txt3);font-size:10px;">нет закрытых сделок</span>';

  el.style.display = '';
  el.innerHTML = `
    <div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--txt2);margin-bottom:8px;border-bottom:1px solid var(--border2);padding-bottom:6px;">
      📊 Глобальная статистика методов (все тикеры агрегированно)
    </div>
    <div style="margin-bottom:10px;">
      <div style="font-size:10px;font-weight:600;color:var(--txt2);margin-bottom:3px;">🎯 Что заставляет входить (топ-методы «за» на входе, ×раз · win%)</div>
      <div>${{drvHtml}}</div>
      <div style="font-size:10px;font-weight:600;color:var(--txt2);margin:8px 0 3px;">🚪 Почему закрываются сделки (доля · win%)</div>
      <div>${{exitHtml}}</div>
    </div>
    <table style="border-collapse:collapse;width:100%;max-width:580px;">
      <thead><tr>
        <th style="text-align:left;font-size:9px;color:var(--txt3);padding:2px 8px;font-weight:400;letter-spacing:.06em;">МЕТОД</th>
        <th style="text-align:right;font-size:9px;color:var(--txt3);padding:2px 8px;font-weight:400;">ЗА win%</th>
        <th style="text-align:right;font-size:9px;color:var(--txt3);padding:2px 8px;font-weight:400;">ПРОТИВ win%</th>
        <th style="text-align:right;font-size:9px;color:var(--txt3);padding:2px 8px;font-weight:400;">ЧИСТЫЙ%</th>
        <th></th>
      </tr></thead>
      <tbody>${{trs}}</tbody>
    </table>
    <div style="font-size:9px;color:var(--txt3);margin-top:6px;">Показаны все ${{rows.length}} методов каталога (${{nShown}} с данными, остальные «нет сделок» — молчали или без провайдерных данных). «Против» = когда метод в меньшинстве. Чистый% = ЗА − ПРОТИВ. Зелёный ≥60% / +8%, красный ≤42% / −5%. Оранжевый n — мало сделок (&lt;5), цифры ненадёжны.</div>
    <div style="font-size:9px;color:#c99a4a;margin-top:4px;">⚠ Кнопки «включить/выключить» и «отключить методы для прогона» наверху меняют настройку для СЛЕДУЮЩЕГО прогона. Цифры в таблице выше уже посчитаны прошлым прогоном и не пересчитываются на лету — нажми «Запустить» ещё раз, чтобы применить изменения.</div>
    <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;">
      <button class="btn-pill btn-sm ghost" onclick="autoDisableWeakMethods()" title="Выключить методы с win% ЗА ≤25% (минимум 5 сделок в роли)">⛔ выкл слабые (≤25%)</button>
      <button class="btn-pill btn-sm ghost" onclick="autoInvertAntisignals()" title="Инвертировать методы где ПРОТИВ win% > ЗА win% + 10% (антисигналы)">↔ инверт анти-сигналы</button>
      <button class="btn-pill btn-sm ghost" onclick="downloadTradesCsv()" title="Скачать CSV всех сделок с техническими параметрами и контекстом свечей">📥 CSV сделок</button>
    </div>
  `;
}}

function autoDisableWeakMethods() {{
  const agg = {{}};
  for (const r of _backtestRows) {{
    if (!r.method_stats) continue;
    for (const [name, s] of Object.entries(r.method_stats)) {{
      if (!agg[name]) agg[name] = {{an: 0, aw: 0}};
      agg[name].an += s.agree_n || 0;
      agg[name].aw += s.agree_win || 0;
    }}
  }}
  let disabled = 0;
  for (const [name, s] of Object.entries(agg)) {{
    if (s.an < 5) continue;
    const wr = s.aw / s.an;
    if (wr <= 0.25) {{
      initMethodCheckboxes();
      const cb = document.getElementById('dm_' + name);
      if (cb && !cb.checked) {{ cb.checked = true; disabled++; updateDisabledCount(); }}
    }}
  }}
  renderGlobalMethodStats();
  alert(`Выключено методов: ${{disabled}} (win% ЗА ≤25%, n≥5)`);
}}

function autoInvertAntisignals() {{
  const agg = {{}};
  for (const r of _backtestRows) {{
    if (!r.method_stats) continue;
    for (const [name, s] of Object.entries(r.method_stats)) {{
      if (!agg[name]) agg[name] = {{an: 0, aw: 0, dn: 0, dw: 0}};
      agg[name].an += s.agree_n || 0;
      agg[name].aw += s.agree_win || 0;
      agg[name].dn += s.disagree_n || 0;
      agg[name].dw += s.disagree_win || 0;
    }}
  }}
  let inverted = 0;
  for (const [name, s] of Object.entries(agg)) {{
    if (s.an < 5 || s.dn < 5) continue;
    const fwr = s.aw / s.an;
    const dwr = s.dw / s.dn;
    if (dwr - fwr > 0.10) {{
      // ПРОТИВ выигрывает на >10% — метод антисигнал
      const inv = document.getElementById('inv_' + name);
      if (inv && inv.dataset.active !== '1') {{ toggleInvertMethod(name); inverted++; }}
    }}
  }}
  renderGlobalMethodStats();
  alert(`Инвертировано методов: ${{inverted}} (ПРОТИВ − ЗА > 10%, n≥5)`);
}}

async function downloadTradesCsv() {{
  const resp = await fetch('/api/export_trades_csv');
  if (!resp.ok) {{
    const j = await resp.json().catch(() => ({{}}));
    alert('Ошибка: ' + (j.error || resp.statusText));
    return;
  }}
  const blob = await resp.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'trades_export.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
}}

function toggleMethodInRun(name) {{
  initMethodCheckboxes();
  const cb = document.getElementById('dm_' + name);
  if (cb) {{ cb.checked = !cb.checked; updateDisabledCount(); }}
  // если отключаем — снять инверсию
  if (cb && cb.checked) {{
    const inv = document.getElementById('inv_' + name);
    if (inv && inv.dataset.active === '1') toggleInvertMethod(name);
  }}
  renderGlobalMethodStats();
}}

function toggleInvertMethodFromStats(name) {{
  initMethodCheckboxes();
  toggleInvertMethod(name);
  updateDisabledCount();
  renderGlobalMethodStats();
}}

function selectTicker(ticker) {{
  const sel = document.getElementById('tc_ticker');
  if (!sel) return;
  let found = false;
  for (const opt of sel.options) {{
    if (opt.value === ticker) {{ sel.value = ticker; found = true; break; }}
  }}
  if (found) {{
    sel.scrollIntoView({{behavior:'smooth', block:'nearest'}});
    loadTradeChart();
  }}
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

// Накопленные строки текущего прогона — храним как данные, не HTML, чтобы
// можно было перерисовывать таблицу (фильтр "скрыть нулевые", итоговая
// строка) без повторного запроса к серверу.
let _backtestRows = [];
let _droppedRows = [];
// Реестр сделок для раскрытия «все методы» и покопийной выгрузки. uid → {{ticker, t}}.
let _tradeReg = {{}};

function _isZeroResult(r) {{
  // "нулевой результат" — тикер досчитан, но сделок не нашлось (n_trades===0),
  // а не ошибка/пропуск (у тех n_trades вообще не определён).
  return r.n_trades !== undefined && r.n_trades === 0;
}}

function _summaryOne(label, rows, borderStyle) {{
  const valid = rows.filter(r => r.win_rate !== undefined && r.n_trades > 0);
  if (!valid.length) return `<tr style="${{borderStyle}}"><td style="color:var(--txt3)">${{label}}</td><td colspan="6" style="color:var(--txt3)">нет данных</td></tr>`;
  const n = valid.reduce((s, r) => s + r.n_trades, 0);
  const wr = valid.reduce((s, r) => s + r.win_rate * r.n_trades, 0) / n;
  const exp = valid.reduce((s, r) => s + (r.expectancy_pct || 0) * r.n_trades, 0) / n;
  const avgR = valid.reduce((s, r) => s + (r.avg_r || 0) * r.n_trades, 0) / n;
  const tickers = new Set(valid.map(r => r.ticker)).size;
  const wrColor = wr > 0.55 ? 'color:var(--pos)' : wr < 0.45 ? 'color:var(--neg)' : '';
  const expColor = exp > 0 ? 'color:var(--pos)' : exp < 0 ? 'color:var(--neg)' : '';
  return `<tr style="${{borderStyle}}">` +
    `<td style="font-weight:bold">${{label}} <span style="font-weight:normal;color:var(--txt3);font-size:10px">(${{tickers}} тик.)</span></td>` +
    `<td></td><td>${{n}}</td>` +
    `<td style="${{wrColor}};font-weight:bold">${{(wr * 100).toFixed(1)}}%</td>` +
    `<td>${{avgR.toFixed(2)}}</td>` +
    `<td style="${{expColor}};font-weight:bold">${{(exp * 100).toFixed(2)}}%</td>` +
    `<td></td></tr>`;
}}

function summaryRowToHtml(rows) {{
  const fixed = rows.filter(r => r.mode === 'fixed');
  const atr = rows.filter(r => r.mode !== 'fixed');
  const allValid = rows.filter(r => r.win_rate !== undefined && r.n_trades > 0);
  if (!allValid.length) return '';
  let html = '';
  if (fixed.length && atr.length) {{
    html += _summaryOne('Фиксированные стопы', fixed, 'border-top:2px solid var(--txt3)');
    html += _summaryOne('ATR walk-forward', atr, '');
    html += _summaryOne('ИТОГО', allValid, 'border-top:1px dashed var(--txt3)');
  }} else {{
    html += _summaryOne('ИТОГО', allValid, 'border-top:2px solid var(--txt3)');
  }}
  return html;
}}

function comparisonTableToHtml(rows) {{
  // Группируем по тикеру: {ticker: {fixed: row, atr: row}}
  const byTicker = {{}};
  for (const r of rows) {{
    if (r.win_rate === undefined || !r.n_trades) continue;
    if (!byTicker[r.ticker]) byTicker[r.ticker] = {{}};
    if (r.mode === 'fixed') byTicker[r.ticker].fixed = r;
    else byTicker[r.ticker].atr = r;
  }}
  const pairs = Object.entries(byTicker).filter(([, v]) => v.fixed && v.atr);
  if (!pairs.length) return '';

  const fmt = (v, digits, pct) => v != null ? (pct ? (v*100).toFixed(digits)+'%' : v.toFixed(digits)) : '—';
  const deltaColor = (d) => d == null ? '' : d > 0.005 ? 'color:var(--pos)' : d < -0.005 ? 'color:var(--neg)' : '';

  let html = '<table style="border-collapse:collapse;width:100%;font-size:11px;margin-top:8px">';
  html += '<tr style="color:var(--txt3)"><th style="text-align:left;padding:2px 6px">Тикер</th>'
        + '<th colspan="3" style="padding:2px 6px;border-left:1px solid var(--border2)">Фиксированные</th>'
        + '<th colspan="3" style="padding:2px 6px;border-left:1px solid var(--border2)">ATR walk-forward</th>'
        + '<th colspan="2" style="padding:2px 6px;border-left:1px solid var(--border2)">Δ (ATR − fixed)</th></tr>';
  html += '<tr style="color:var(--txt3);font-size:10px"><th></th>'
        + '<th style="padding:1px 6px;border-left:1px solid var(--border2)">n</th><th style="padding:1px 6px">Win%</th><th style="padding:1px 6px">Exp%</th>'
        + '<th style="padding:1px 6px;border-left:1px solid var(--border2)">n</th><th style="padding:1px 6px">Win%</th><th style="padding:1px 6px">Exp%</th>'
        + '<th style="padding:1px 6px;border-left:1px solid var(--border2)">ΔWin%</th><th style="padding:1px 6px">ΔExp%</th></tr>';

  // Сортируем по ΔExp% desc
  pairs.sort((a, b) => {{
    const da = (a[1].atr.expectancy_pct||0) - (a[1].fixed.expectancy_pct||0);
    const db = (b[1].atr.expectancy_pct||0) - (b[1].fixed.expectancy_pct||0);
    return db - da;
  }});

  for (const [ticker, {{fixed, atr}}] of pairs) {{
    const dwr = atr.win_rate - fixed.win_rate;
    const dexp = (atr.expectancy_pct||0) - (fixed.expectancy_pct||0);
    const bg = pairs.indexOf(pairs.find(p => p[0] === ticker)) % 2 === 0 ? 'background:var(--bg2)' : '';
    html += `<tr style="${{bg}}">` +
      `<td style="padding:2px 6px;font-weight:bold">${{ticker}}</td>` +
      `<td style="padding:2px 6px;border-left:1px solid var(--border2);text-align:right">${{fixed.n_trades}}</td>` +
      `<td style="padding:2px 6px;text-align:right">${{fmt(fixed.win_rate,1,true)}}</td>` +
      `<td style="padding:2px 6px;text-align:right">${{fmt(fixed.expectancy_pct,2,true)}}</td>` +
      `<td style="padding:2px 6px;border-left:1px solid var(--border2);text-align:right">${{atr.n_trades}}</td>` +
      `<td style="padding:2px 6px;text-align:right">${{fmt(atr.win_rate,1,true)}}</td>` +
      `<td style="padding:2px 6px;text-align:right">${{fmt(atr.expectancy_pct,2,true)}}</td>` +
      `<td style="padding:2px 6px;border-left:1px solid var(--border2);text-align:right;${{deltaColor(dwr)}}">${{dwr>=0?'+':''}}${{(dwr*100).toFixed(1)}}%</td>` +
      `<td style="padding:2px 6px;text-align:right;${{deltaColor(dexp)}}">${{dexp>=0?'+':''}}${{(dexp*100).toFixed(2)}}%</td>` +
      `</tr>`;
  }}
  html += '</table>';
  return html;
}}

function renderResultsTable() {{
  if (_dashViewActive) {{ renderDashGrid(); return; }}
  const table = document.getElementById('results');
  const hideZero = document.getElementById('hide_zero').checked;
  const minTrades = parseInt(document.getElementById('min_trades').value) || 0;
  const sortBy = document.getElementById('sort_by').value;
  const topN = parseInt(document.getElementById('top_n').value) || 0;
  const topNWorst = document.getElementById('top_n_worst').checked;

  let shown = _backtestRows.filter(r => r.error === undefined || r.n_trades !== undefined);
  if (hideZero) shown = shown.filter(r => !_isZeroResult(r));
  if (minTrades > 0) shown = shown.filter(r => (r.n_trades || 0) >= minTrades);

  if (sortBy) {{
    const [field, dir] = sortBy.split('_');
    const key = field === 'win' ? 'win_rate' : field === 'exp' ? 'expectancy_pct' : field === 'avgr' ? 'avg_r' : 'n_trades';
    shown = [...shown].sort((a, b) => {{
      const av = a[key] ?? (dir === 'desc' ? -Infinity : Infinity);
      const bv = b[key] ?? (dir === 'desc' ? -Infinity : Infinity);
      return dir === 'desc' ? bv - av : av - bv;
    }});
  }}
  if (topN > 0) shown = topNWorst ? shown.slice(-topN) : shown.slice(0, topN);

  const errors = _backtestRows.filter(r => r.error !== undefined && r.n_trades === undefined);
  let html = '<tr><th>Тикер</th><th>Режим</th><th>Сделок</th><th>Win%</th><th>avg R</th><th>Exp%</th><th>M1/M2/M3 win% (когда согласны)</th></tr>';
  html += droppedToHtml(_droppedRows);
  html += _oiCovBanner(shown);
  html += rowsToHtml(errors.concat(shown));
  html += summaryRowToHtml(shown);
  table.innerHTML = html;

  // Таблица сравнения fixed vs ATR — отдельный блок под основной таблицей
  const cmp = comparisonTableToHtml(shown);
  const cmpDiv = document.getElementById('compare_block');
  if (cmpDiv) {{
    if (cmp) {{
      cmpDiv.innerHTML = `<details><summary style="cursor:pointer;font-size:12px;color:var(--txt3);padding:4px 0">📊 Сравнение fixed vs ATR по тикерам</summary>${{cmp}}</details>`;
      cmpDiv.style.display = '';
    }} else {{
      cmpDiv.style.display = 'none';
    }}
  }}
}}

function _rowToText(r) {{
  const lines = [];
  if (r.error !== undefined && r.n_trades === undefined) {{
    lines.push(`${{r.ticker}}\t${{r.mode}}\tERROR: ${{r.error || ''}}`);
    if (r.traceback) lines.push(r.traceback);
    return lines.join('\\n');
  }}
  const winPct = r.win_rate !== undefined ? (r.win_rate * 100).toFixed(1) + '%' : '';
  const exp = r.expectancy_pct !== undefined ? (r.expectancy_pct * 100).toFixed(2) + '%' : '';
  const avgR = r.avg_r !== undefined ? r.avg_r.toFixed(2) : '';
  const models = r.model_stats ? Object.entries(r.model_stats).map(([k, s]) => {{
    const wr = s.agree_win_rate !== null && s.agree_win_rate !== undefined ? (s.agree_win_rate * 100).toFixed(0) + '%' : '—';
    return `${{k.replace('_CLUSTER','')}}:${{wr}}(n=${{s.agree_n}})`;
  }}).join(' / ') : '';
  lines.push(`${{r.ticker}}\t${{r.mode}}\t${{r.n_trades ?? 0}}\t${{winPct}}\t${{avgR}}\t${{exp}}\t${{models}}`);
  if (r.what_if) {{
    const wi = Object.entries(r.what_if).filter(([,s])=>s&&s.n_trades).map(([k,s])=>{{
      const wr = s.win_rate !== null && s.win_rate !== undefined ? (s.win_rate*100).toFixed(0)+'%' : '—';
      const ep = s.expectancy_pct !== null && s.expectancy_pct !== undefined ? (s.expectancy_pct*100).toFixed(2)+'%' : '';
      return `${{k}}: ${{wr}} n=${{s.n_trades}}${{ep?' эксп '+ep:''}}`;
    }}).join(' / ');
    if (wi) lines.push(`  Если бы слушали только модель: ${{wi}}`);
  }}
  if (r.method_stats) {{
    lines.push('  Attribution по методам:');
    lines.push('  метод\tза n\tза win%\tпротив n\tпротив win%');
    for (const [m, s] of Object.entries(r.method_stats)) {{
      const fw = s.agree_win_rate !== null && s.agree_win_rate !== undefined ? (s.agree_win_rate*100).toFixed(0)+'%' : '—';
      const aw = s.disagree_win_rate !== null && s.disagree_win_rate !== undefined ? (s.disagree_win_rate*100).toFixed(0)+'%' : '—';
      lines.push(`  ${{m}}\t${{s.agree_n}}\t${{fw}}\t${{s.disagree_n}}\t${{aw}}`);
    }}
  }}
  if (r.method_stats_by_regime) {{
    for (const [regime, ms] of Object.entries(r.method_stats_by_regime)) {{
      lines.push(`  Attribution по методам (режим ${{regime}}):`);
      for (const [m, s] of Object.entries(ms)) {{
        const fw = s.agree_win_rate !== null && s.agree_win_rate !== undefined ? (s.agree_win_rate*100).toFixed(0)+'%' : '—';
        const aw = s.disagree_win_rate !== null && s.disagree_win_rate !== undefined ? (s.disagree_win_rate*100).toFixed(0)+'%' : '—';
        lines.push(`  ${{m}}\t${{s.agree_n}}\t${{fw}}\t${{s.disagree_n}}\t${{aw}}`);
      }}
    }}
  }}
  if (r.trades_list && r.trades_list.length) {{
    lines.push('  Сделки по времени:');
    lines.push('  #\tДата\tDir\tWin\tR\tcumR\tТоп ЗА\tТоп ПРОТИВ');
    let cumR = 0;
    r.trades_list.forEach((t, i) => {{
      cumR += t.r;
      const forStr = t.fa.map(([n, s]) => `${{n}}(${{s.toFixed(2)}})` ).join(', ');
      const agStr = t.ag.map(([n, s]) => `${{n}}(${{s.toFixed(2)}})` ).join(', ');
      lines.push(`  ${{i+1}}\t${{t.t}}\t${{t.d}}\t${{t.w ? 'W' : 'L'}}\t${{t.r.toFixed(2)}}\t${{cumR.toFixed(2)}}\t${{forStr}}\t${{agStr}}`);
    }});
  }}
  return lines.join('\\n');
}}

// ── Общий помощник копирования в буфер ──
async function _copyToClipboard(text, btn, okLabel) {{
  const orig = btn ? btn.textContent : '';
  try {{
    await navigator.clipboard.writeText(text);
  }} catch(e) {{
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
  }}
  if (btn) {{ btn.textContent = okLabel || '✓ скопировано'; setTimeout(() => btn.textContent = orig, 1500); }}
}}

// Все методы сделки, приведённые к направлению: ЗА (>0), ПРОТИВ (<0), молчали (=0).
function _tradeMethodsSplit(t) {{
  const dir = t.d === 'L' ? 1 : -1;
  const ms = (t.ms || []).slice().sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return {{
    forL: ms.filter(([, s]) => s * dir > 0),
    agL:  ms.filter(([, s]) => s * dir < 0),
    neu:  ms.filter(([, s]) => s * dir === 0),
    n: ms.length,
  }};
}}

function _tradeFullMethodsHtml(t) {{
  const sp = _tradeMethodsSplit(t);
  const chip = (arr, cls) => arr.length
    ? arr.map(([n, s]) => `<span title="${{_METHOD_RU[n]||n}}" style="display:inline-block;font-size:10px;padding:1px 6px;margin:1px;border:1px solid var(--border2);border-radius:9px;color:${{cls}}">${{n.replace(/_/g,' ')}} ${{s>=0?'+':''}}${{s.toFixed(2)}}</span>`).join('')
    : '<span style="color:var(--txt3);font-size:10px">—</span>';
  return `<div style="padding:4px 2px">
    <div style="font-size:10px;color:var(--txt2);margin:2px 0"><b>ЗА (${{sp.forL.length}}):</b> ${{chip(sp.forL, '#7dcc7d')}}</div>
    <div style="font-size:10px;color:var(--txt2);margin:2px 0"><b>ПРОТИВ (${{sp.agL.length}}):</b> ${{chip(sp.agL, '#e07070')}}</div>
    ${{sp.neu.length ? `<div style="font-size:10px;color:var(--txt3);margin:2px 0"><b>молчали (${{sp.neu.length}}):</b> ${{sp.neu.map(([n])=>n.replace(/_/g,' ')).join(', ')}}</div>` : ''}}
  </div>`;
}}

// Текст одной сделки со всеми методами — для копирования.
function _tradeFullMethodsText(ticker, t, idx) {{
  const sp = _tradeMethodsSplit(t);
  const xrRu = {{take: 'тейк', stop: 'стоп', timeout: 'таймаут'}};
  const f = arr => arr.map(([n, s]) => `${{n}} ${{s>=0?'+':''}}${{s.toFixed(2)}}`).join(', ') || '—';
  const L = [];
  L.push(`${{ticker||''}} #${{idx!=null?idx+1:''}} ${{t.t}} ${{t.d}} ${{t.w?'WIN':'LOSS'}} R=${{t.r.toFixed(2)}} выход=${{xrRu[t.xr]||t.xr||'—'}}`);
  if (t.ep) L.push(`  цены: вход ${{t.ep}} → выход ${{t.xp}} | тейк ${{t.tp}} стоп ${{t.sp}}  MFE ${{t.mfe!=null?t.mfe.toFixed(2)+'%':'—'}} MAE ${{t.mae!=null?t.mae.toFixed(2)+'%':'—'}}`);
  L.push(`  ЗА (${{sp.forL.length}}): ${{f(sp.forL)}}`);
  L.push(`  ПРОТИВ (${{sp.agL.length}}): ${{f(sp.agL)}}`);
  if (sp.neu.length) L.push(`  молчали (${{sp.neu.length}}): ${{sp.neu.map(([n])=>n).join(', ')}}`);
  return L.join('\\n');
}}

function toggleTradeMethods(uid, btn) {{
  const el = document.getElementById('tmrow_' + uid);
  if (!el) return;
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : '';
  if (btn) btn.textContent = open ? '▾ методы' : '▴ скрыть';
}}

function copyTrade(uid, btn) {{
  const rec = _tradeReg[uid];
  if (!rec) return;
  _copyToClipboard(_tradeFullMethodsText(rec.ticker, rec.t, rec.i), btn, '✓');
}}

// Вердикт по тикеру: сводка + точность методов (лучшие/худшие) + причины выходов.
function _tickerVerdictLines(r) {{
  const L = [];
  const winPct = r.win_rate !== undefined ? (r.win_rate*100).toFixed(1)+'%' : '—';
  const exp = r.expectancy_pct !== undefined ? (r.expectancy_pct*100).toFixed(2)+'%' : '—';
  const avgR = r.avg_r !== undefined ? r.avg_r.toFixed(2) : '—';
  L.push(`ВЕРДИКТ ${{r.ticker}} [${{r.mode}}]: сделок ${{r.n_trades??0}}, win ${{winPct}}, avg R ${{avgR}}, ожидание ${{exp}}`);
  // Причины выхода по этому тикеру
  if (r.trades_list && r.trades_list.length) {{
    const ex = {{}};
    for (const t of r.trades_list) {{ const k=t.xr||'—'; if(!ex[k])ex[k]={{n:0,w:0}}; ex[k].n++; ex[k].w+=(t.w?1:0); }}
    const xrRu = {{take:'тейк',stop:'стоп',timeout:'таймаут'}};
    const parts = Object.entries(ex).map(([k,s])=>`${{xrRu[k]||k}} ${{s.n}} (win ${{(s.w/s.n*100).toFixed(0)}}%)`);
    L.push(`  выходы: ${{parts.join(' · ')}}`);
  }}
  // Точность методов: лучшие/худшие по ЗА win% (n≥3)
  if (r.method_stats) {{
    const rows = Object.entries(r.method_stats)
      .filter(([,s]) => (s.agree_n||0) >= 3 && s.agree_win_rate != null)
      .map(([n,s]) => ({{n, fwr:s.agree_win_rate, fn:s.agree_n}}));
    if (rows.length) {{
      const best = [...rows].sort((a,b)=>b.fwr-a.fwr).slice(0,5);
      const worst = [...rows].sort((a,b)=>a.fwr-b.fwr).slice(0,5);
      L.push(`  лучшие методы: ${{best.map(x=>`${{x.n}} ${{(x.fwr*100).toFixed(0)}}% (n=${{x.fn}})`).join(', ')}}`);
      L.push(`  худшие методы: ${{worst.map(x=>`${{x.n}} ${{(x.fwr*100).toFixed(0)}}% (n=${{x.fn}})`).join(', ')}}`);
    }}
  }}
  return L;
}}

// Полный текст по одному тикеру: вердикт + attribution + все сделки со всеми методами.
function _tickerFullText(r) {{
  const L = [];
  L.push('='.repeat(60));
  L.push(..._tickerVerdictLines(r));
  L.push('');
  L.push(_rowToText(r));  // attribution-таблицы + сделки (топ)
  if (r.trades_list && r.trades_list.length) {{
    L.push('');
    L.push('  --- Каждая сделка: все методы ЗА/ПРОТИВ ---');
    r.trades_list.forEach((t, i) => L.push(_tradeFullMethodsText(r.ticker, t, i)));
  }}
  return L.join('\\n');
}}

function copyTicker(ticker, btn) {{
  const r = _backtestRows.find(x => x.ticker === ticker);
  if (!r) {{ if(btn) btn.textContent='нет данных'; return; }}
  _copyToClipboard(_tickerFullText(r), btn, '✓ тикер');
}}

async function copyAllResults(btn) {{
  if (!_backtestRows.length) {{ alert('Нет результатов'); return; }}
  // Блок вердиктов по каждому тикеру (сводка + точность методов + выходы) в начале.
  let text = '=== ВЕРДИКТЫ ПО ТИКЕРАМ ===\\n';
  for (const r of _backtestRows) {{
    if (r.n_trades === undefined) continue;
    text += _tickerVerdictLines(r).join('\\n') + '\\n';
  }}
  text += '\\n=== ТАБЛИЦА ===\\n';
  const header = 'Тикер\tРежим\tСделок\tWin%\tavg R\tExp%\tM1/M2/M3';
  text += header + '\\n' + _backtestRows.map(_rowToText).join('\\n') + '\\n';
  // Добавляем сделки по каждому тикеру
  const rowsWithTrades = _backtestRows.filter(r => r.trades_list && r.trades_list.length);
  if (rowsWithTrades.length) {{
    text += '\\n--- Сделки ---\\n';
    text += 'Тикер\tДата\tDir\tWin\tR\tMFE%\tMAE%\tВход\tВыход\tТейк\tСтоп\tHi-Lo%\\n';
    for (const r of rowsWithTrades) {{
      for (const t of r.trades_list) {{
        const l1 = t.l1pct != null && t.l1pct >= 0 ? (t.l1pct*100).toFixed(0)+'%' : '—';
        text += `${{r.ticker}}\t${{t.t}}\t${{t.d}}\t${{t.w?'W':'L'}}\t${{t.r.toFixed(2)}}\t${{t.mfe!=null?t.mfe.toFixed(2)+'%':'—'}}\t${{t.mae!=null?t.mae.toFixed(2)+'%':'—'}}\t${{t.ep||'—'}}\t${{t.xp||'—'}}\t${{t.tp||'—'}}\t${{t.sp||'—'}}\t${{l1}}\\n`;
      }}
    }}
    // Полный разбор по методам (за/против, знак приведён к направлению сделки) +
    // причина выхода — по каждой сделке отдельной строкой.
    const _xrRu = {{take: 'тейк', stop: 'стоп', timeout: 'таймаут'}};
    text += '\\n--- За / Против по методам (все, знак к направлению) ---\\n';
    for (const r of rowsWithTrades) {{
      for (const t of r.trades_list) {{
        const dir = t.d === 'L' ? 1 : -1;
        const ms = t.ms || [];
        const forL = ms.filter(([n, s]) => s * dir > 0)
          .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
          .map(([n, s]) => n + ' ' + (s > 0 ? '+' : '') + s.toFixed(2));
        const agL = ms.filter(([n, s]) => s * dir < 0)
          .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
          .map(([n, s]) => n + ' ' + s.toFixed(2));
        const xr = _xrRu[t.xr] || t.xr || '—';
        text += `${{r.ticker}}\t${{t.t}}\t${{t.d}}\tвыход:${{xr}}\tЗА: ${{forL.join(', ') || '—'}}\tПРОТИВ: ${{agL.join(', ') || '—'}}\\n`;
      }}
    }}
  }}
  // Добавляем MFE/MAE если есть
  try {{
    const mfeResp = await fetch('/api/mfe_stats');
    const mfeData = await mfeResp.json();
    if (mfeData.rows && mfeData.rows.length) {{
      text += '\\n--- MFE / MAE из history.json ---\\n';
      text += 'Тикер\tN\tMFE мед.%\tMAE мед.%\tMFE/MAE\tQuality мед.%\\n';
      for (const row of mfeData.rows) {{
        text += `${{row.ticker}}\t${{row.n}}\t${{row.mfe_med}}\t${{row.mae_med}}\t${{row.ratio}}\t${{row.q_med ?? ''}}\\n`;
      }}
      const t = mfeData.total;
      if (t) text += `ИТОГО\t${{t.n}}\t${{t.mfe_med}}\t${{t.mae_med}}\t${{t.ratio}}\t${{t.q_med ?? ''}}\\n`;
    }}
  }} catch(e) {{}}
  try {{
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = '✓ скопировано';
    setTimeout(() => btn.textContent = orig, 1500);
  }} catch(e) {{
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    btn.textContent = '✓'; setTimeout(() => btn.textContent = '📋 копировать всё', 1500);
  }}
}}

async function calibrateMethodWeights(btn) {{
  if (!_backtestRows.length) {{ alert('Нет результатов бэктеста'); return; }}
  // Для каждого тикера и каждого метода вычисляем мультипликатор из атрибуции.
  // overall win rate по тикеру = r.win_rate; для метода: agree_win_rate vs disagree_win_rate.
  // Если метод против (disagree_win_rate - agree_win_rate > 0.2, disagree_n >= 3) → mult=0.1.
  // Если agree_n >= 5 → mult = clamp(agree_win_rate / overallWr, 0.2, 2.0).
  // Иначе → 1.0 (нейтральный).
  const MIN_FOR_N = 5, MIN_AGAINST_N = 3, ANTI_DELTA = 0.2;
  const weights = {{}};
  for (const r of _backtestRows) {{
    if (!r.ticker || !r.method_stats || typeof r.win_rate !== 'number') continue;
    const wr = r.win_rate / 100;
    if (wr <= 0) continue;
    const tickerMults = {{}};
    for (const [method, ms] of Object.entries(r.method_stats)) {{
      const fn = ms.agree_n || 0;
      const an = ms.disagree_n || 0;
      const fwr = ms.agree_win_rate != null ? ms.agree_win_rate : null;
      const awr = ms.disagree_win_rate != null ? ms.disagree_win_rate : null;
      let mult = 1.0;
      if (fwr !== null && awr !== null && an >= MIN_AGAINST_N && (awr - fwr) > ANTI_DELTA) {{
        mult = 0.1; // антисигнал — подавить
      }} else if (fwr !== null && fn >= MIN_FOR_N) {{
        mult = Math.max(0.2, Math.min(2.0, fwr / wr));
      }}
      if (Math.abs(mult - 1.0) > 0.01) tickerMults[method] = +mult.toFixed(3);
    }}
    if (Object.keys(tickerMults).length) weights[r.ticker] = tickerMults;
  }}
  if (!Object.keys(weights).length) {{ alert('Недостаточно данных атрибуции (нужно agree_n≥5)'); return; }}
  btn.disabled = true; btn.textContent = '⏳ сохранение…';
  try {{
    const resp = await fetch('/api/save_method_weights', {{
      method: 'POST', headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify(weights),
    }});
    const j = await resp.json();
    btn.textContent = j.ok ? `✓ сохранено ${{j.tickers}}т` : `Ошибка: ${{j.error}}`;
    setTimeout(() => {{ btn.textContent = '💾 веса методов'; btn.disabled = false; }}, 2500);
  }} catch(e) {{
    btn.textContent = 'Ошибка сети'; btn.disabled = false;
  }}
}}

async function resetWeights() {{
  if (!confirm('Сбросить все Hedge-веса методов в oi_weights.json до 0.30?\\nIC-prior не затрагивается.')) return;
  const btn = document.getElementById('btnResetWeights');
  btn.disabled = true; btn.textContent = '⏳…';
  try {{
    const resp = await fetch('/api/reset_weights', {{method: 'POST', headers: {{'Content-Type': 'application/json'}}, body: '{{}}'}});
    const j = await resp.json();
    if (j.ok) {{
      btn.textContent = `✓ сброшено ${{j.reset_count}} записей (${{j.tickers}}т)`;
    }} else {{
      btn.textContent = `Ошибка: ${{j.error}}`;
    }}
  }} catch(e) {{
    btn.textContent = 'Ошибка сети';
  }}
  setTimeout(() => {{ btn.textContent = '🔄 сброс весов'; btn.disabled = false; }}, 3000);
}}

let _progressTimer = null;

function _fmtEta(sec) {{
  if (!isFinite(sec) || sec < 0) return '';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m > 0 ? `${{m}}м ${{s}}с` : `${{s}}с`;
}}

function startProgressPolling(tickers, statusElId) {{
  const el = document.getElementById(statusElId);
  const startedAt = Date.now();
  const DONE_STATUSES = new Set(['готово', 'ошибка', 'ошибка API', 'нет истории', 'пропуск']);
  const statusRu = {{
    'в очереди': 'в очереди', 'загрузка свечей': 'грузит свечи', 'готово': '✓ готово',
    'ошибка': '✗ ошибка', 'ошибка API': '✗ ошибка API', 'нет истории': '— нет истории', 'пропуск': '— пропуск',
  }};
  const render = (progress) => {{
    const total = tickers.length;
    const doneCount = tickers.filter(t => progress[t] && DONE_STATUSES.has(progress[t].status)).length;
    const errCount  = tickers.filter(t => progress[t] && progress[t].status.startsWith('ошибка')).length;
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const pct = total > 0 ? doneCount / total : 0;

    let etaStr = '';
    if (doneCount > 0 && doneCount < total) {{
      const etaSec = (elapsedSec / doneCount) * (total - doneCount);
      etaStr = ` · ~${{_fmtEta(etaSec)}}`;
    }} else if (doneCount === 0 && total > 1) {{
      etaStr = ' · считаю...';
    }}
    const errBadge = errCount > 0 ? `<span style="color:var(--neg);margin-left:6px">✗${{errCount}}</span>` : '';
    const doneColor = doneCount === total ? 'var(--pos)' : 'var(--txt)';

    // Тонкая прогресс-линия
    const barW = Math.round(pct * 100);
    const bar = `<div style="height:3px;border-radius:2px;background:var(--bg2);margin:4px 0;overflow:hidden">
      <div style="height:100%;width:${{barW}}%;background:var(--accent,#5c6bc0);border-radius:2px;transition:width .4s"></div>
    </div>`;

    // Детали по тикерам — свёрнуты по умолчанию
    const parts = tickers.map(t => {{
      const p = progress[t];
      const status = p ? (statusRu[p.status] || p.status) : '…';
      const c = p && p.status === 'готово' ? 'var(--pos)' : p && p.status.startsWith('ошибка') ? 'var(--neg)' : 'var(--txt3)';
      return `<span style="color:${{c}};white-space:nowrap">${{t}}&thinsp;${{status}}</span>`;
    }}).join(' <span style="color:var(--border2)">·</span> ');

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;">
        <span style="color:${{doneColor}};font-weight:600">${{doneCount}}/${{total}}</span>
        <span style="color:var(--txt3)">${{etaStr}}</span>
        ${{errBadge}}
        <span style="margin-left:auto;font-size:11px;color:var(--txt3);cursor:pointer;user-select:none"
          onclick="this.closest('.progress-wrap').querySelector('.progress-detail').style.display=this.closest('.progress-wrap').querySelector('.progress-detail').style.display==='none'?'':'none';this.textContent=this.textContent==='▸ детали'?'▾ детали':'▸ детали'"
        >▸ детали</span>
      </div>
      ${{bar}}
      <div class="progress-detail" style="display:none;font-size:10px;color:var(--txt3);margin-top:2px;line-height:1.7">${{parts}}</div>`;
  }};
  if (el && !el.classList.contains('progress-wrap')) el.classList.add('progress-wrap');
  render({{}});
  _progressTimer = setInterval(async () => {{
    try {{
      const resp = await fetch('/api/progress');
      const data = await resp.json();
      const prog = data.progress || {{}};
      render(prog);
      // Останавливаем опрос когда все тикеры завершились
      const allDone = tickers.length > 0 && tickers.every(t => prog[t] && DONE_STATUSES.has(prog[t].status));
      if (allDone) stopProgressPolling();
    }} catch (e) {{ /* сетевая ошибка опроса — не критично */ }}
  }}, 800);
}}

function stopProgressPolling() {{
  if (_progressTimer) {{ clearInterval(_progressTimer); _progressTimer = null; }}
}}

const _stageRu = {{narrative: 'narrative', lasso: 'lasso', rules: 'rule_miner', 'готово': 'готово'}};

function startCalibrationPolling(statusElId) {{
  // Калибровка — конвейер из 3 стадий (narrative/lasso/rules) по всем
  // тикерам подряд, а не параллельные независимые тикеры как в бэктесте —
  // поэтому ETA считаем по общему счётчику шагов "_calibration" из
  // /api/progress, а не по per-ticker статусам (см. run_calibration_pipeline).
  const el = document.getElementById(statusElId);
  const startedAt = Date.now();
  const render = (c) => {{
    if (!c) {{ el.textContent = 'запускаю...'; return; }}
    const elapsedSec = (Date.now() - startedAt) / 1000;
    let line = `этап: ${{_stageRu[c.stage] || c.stage}} · шаг ${{c.step}}/${{c.total}}`;
    if (c.ticker) line += ` (${{c.ticker}})`;
    if (c.step > 0 && c.step < c.total) {{
      const etaSec = (elapsedSec / c.step) * (c.total - c.step);
      line += ` · осталось ~${{_fmtEta(etaSec)}}`;
    }}
    el.textContent = line;
  }};
  render(null);
  _progressTimer = setInterval(async () => {{
    try {{
      const resp = await fetch('/api/progress');
      const data = await resp.json();
      render((data.progress || {{}})._calibration);
    }} catch (e) {{ /* сетевая ошибка опроса — не критично */ }}
  }}, 800);
}}

async function cancelRun() {{
  // Останавливает текущий прогон бэктеста/портфельной симуляции (если
  // он есть): сервер убивает уже запущенные воркер-процессы, исходный
  // fetch() в runBacktest/runPortfolioSim вернётся раньше с частичным
  // результатом — отдельно обрабатывать ответ этой кнопки не нужно.
  try {{
    const resp = await fetch('/api/cancel', {{method: 'POST'}});
    const data = await resp.json();
    if (!data.cancelled) {{ alert('Нет активного прогона для остановки'); }}
  }} catch (e) {{
    alert('Не удалось отправить сигнал остановки: ' + e);
  }}
}}

async function checkHistoryCoverage() {{
  const out = document.getElementById('history_coverage_out');
  out.textContent = 'Загрузка...';
  try {{
    const r = await fetch('/api/history_coverage');
    const data = await r.json();
    const rows = data.rows || [];
    if (rows.length === 0) {{ out.textContent = 'history.json пуст — ничего ещё не посчитано.'; return; }}
    out.textContent = rows.map(row =>
      `${{row.ticker}}: ${{row.from}} … ${{row.to}} (${{row.days}} дн., ${{row.trades}} сделок)`
    ).join('\\n');
  }} catch (e) {{
    out.textContent = 'Ошибка: ' + e;
  }}
}}

function _median(arr) {{
  if (!arr.length) return null;
  const s = [...arr].sort((a,b)=>a-b);
  const m = Math.floor(s.length/2);
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
}}

function showMfeStats() {{
  const out = document.getElementById('mfe_stats_out');
  // Считаем из текущего _backtestRows (trades_list с mfe/mae добавленными при прогоне)
  const rows = [];
  const allMfe = [], allMae = [];
  for (const r of _backtestRows) {{
    if (!r.trades_list || !r.trades_list.length) continue;
    const mfes = r.trades_list.map(t=>t.mfe).filter(v=>v!=null && v>0);
    const maes = r.trades_list.map(t=>t.mae).filter(v=>v!=null && v>=0);
    if (!mfes.length) continue;
    const mfeMed = _median(mfes);
    const maeMed = _median(maes);
    const ratio = maeMed > 0 ? mfeMed/maeMed : (mfeMed > 0 ? 99 : 0);
    allMfe.push(...mfes); allMae.push(...maes);
    rows.push({{ticker: r.ticker, n: r.trades_list.length, mfe_med: mfeMed, mae_med: maeMed, ratio}});
  }}

  if (!rows.length) {{
    out.style.display = 'block';
    out.innerHTML = '<span style="color:var(--txt3);font-size:11px;">Нет данных в текущем прогоне (запусти бэктест).</span>';
    return;
  }}

  const totMfe = _median(allMfe), totMae = _median(allMae);
  const totRatio = totMae > 0 ? totMfe/totMae : (totMfe>0?99:0);

  const ratioColor = v => v >= 1.0 ? 'var(--pos)' : v >= 0.7 ? '#f5a623' : 'var(--neg)';
  const pct = v => v == null ? '—' : v.toFixed(3) + '%';
  const ratFmt = v => v >= 99 ? '∞' : v.toFixed(2);

  let html = '<div style="font-size:11px;color:var(--txt3);margin-bottom:4px;">MFE/MAE из текущего прогона. > 1.0 — цена чаще идёт в пользу позиции.</div>';
  html += '<div style="overflow-x:auto"><table style="font-size:11px;border-collapse:collapse;min-width:400px;">';
  html += '<thead><tr style="color:var(--txt3);text-align:right;"><th style="text-align:left;padding:2px 8px;">Тикер</th><th style="padding:2px 8px;">Сделок</th><th style="padding:2px 8px;">MFE мед.</th><th style="padding:2px 8px;">MAE мед.</th><th style="padding:2px 8px;">MFE/MAE</th></tr></thead><tbody>';

  for (const row of rows.sort((a,b)=>a.ratio-b.ratio)) {{
    const rc = ratioColor(row.ratio);
    html += `<tr style="border-top:1px solid var(--border);">
      <td style="padding:2px 8px;color:var(--mem);">${{row.ticker}}</td>
      <td style="padding:2px 8px;text-align:right;color:var(--txt2);">${{row.n}}</td>
      <td style="padding:2px 8px;text-align:right;color:var(--pos);">${{pct(row.mfe_med)}}</td>
      <td style="padding:2px 8px;text-align:right;color:var(--neg);">${{pct(row.mae_med)}}</td>
      <td style="padding:2px 8px;text-align:right;color:${{rc}};font-weight:600;">${{ratFmt(row.ratio)}}</td>
    </tr>`;
  }}

  html += `<tr style="border-top:2px solid var(--border);font-weight:700;">
    <td style="padding:4px 8px;">ИТОГО</td>
    <td style="padding:4px 8px;text-align:right;color:var(--txt2);">${{allMfe.length}}</td>
    <td style="padding:4px 8px;text-align:right;color:var(--pos);">${{pct(totMfe)}}</td>
    <td style="padding:4px 8px;text-align:right;color:var(--neg);">${{pct(totMae)}}</td>
    <td style="padding:4px 8px;text-align:right;color:${{ratioColor(totRatio)}};font-weight:700;">${{ratFmt(totRatio)}}</td>
  </tr>`;
  html += '</tbody></table></div>';
  out.style.display = 'block';
  out.innerHTML = html;
}}

function showRunWeights() {{
  const out = document.getElementById('run_weights_out');
  const rows = _backtestRows.filter(r => r.method_stats && Object.keys(r.method_stats).length);
  if (!rows.length) {{
    out.style.display = 'block';
    out.innerHTML = '<span style="color:var(--txt3);font-size:11px;">Нет данных (запусти бэктест).</span>';
    return;
  }}
  const title = '<div style="font-size:12px;font-weight:bold;margin-bottom:4px;">⚖️ Веса методов — текущий прогон</div>';
  out.style.display = out.style.display === 'block' ? 'none' : 'block';
  if (out.style.display === 'block') {{
    out.innerHTML = title + runWeightsSummaryToHtml(rows);
  }}
}}

// ── Обученные веса прогона + снимки (сохранить/применить к боту) ─────────────
function _collectRunWeights() {{
  const w = {{}};
  for (const r of _backtestRows) {{
    if (r.method_weights && r.method_weights.global) w[r.ticker] = r.method_weights;
  }}
  return w;
}}

function showTrainedWeights() {{
  const out = document.getElementById('trained_weights_out');
  const w = _collectRunWeights();
  const tickers = Object.keys(w);
  refreshWeightsSnapshots();
  if (!tickers.length) {{
    out.style.display = 'block';
    out.innerHTML = '<span style="color:var(--txt3);font-size:11px">Нет обученных весов — запусти бэктест (веса снимаются по ходу прогона).</span>';
    return;
  }}
  out.style.display = out.style.display === 'block' ? 'none' : 'block';
  if (out.style.display !== 'block') return;
  const agg = {{}};
  for (const tk of tickers) {{
    const g = w[tk].global || {{}};
    for (const name in g) {{
      if (!agg[name]) agg[name] = {{sum: 0, n: 0, tot: 0}};
      agg[name].sum += g[name].weight;
      agg[name].n += 1;
      agg[name].tot += (g[name].total || 0);
    }}
  }}
  const list = Object.keys(agg).map(name => ({{name: name, w: agg[name].sum / agg[name].n, n: agg[name].n, tot: agg[name].tot}}));
  list.sort((a, b) => b.w - a.w);
  let html = '<div style="font-size:12px;font-weight:bold;margin:4px 0">🏋 Обученные веса прогона (среднее по ' + tickers.length + ' тик., сорт по весу — сверху точные, снизу инвертированные)</div>';
  html += '<table style="border-collapse:collapse;font-size:11px"><tr style="color:var(--txt3)"><th style="text-align:left;padding:2px 8px">Метод</th><th style="padding:2px 8px">Вес</th><th style="padding:2px 8px">Тикеров</th><th style="padding:2px 8px">Сделок</th></tr>';
  for (const m of list) {{
    let col = 'var(--txt2)';
    if (m.w < 0) col = '#e07070';
    else if (m.w >= 0.6) col = '#7dcc7d';
    else if (m.w <= 0.1) col = 'var(--txt3)';
    const inv = m.w < 0 ? ' <span style="font-size:9px;color:#e07070">инверт</span>' : '';
    html += '<tr><td style="padding:2px 8px;color:var(--txt2);cursor:help" title="' + (_METHOD_RU[m.name] || m.name) + '">' + m.name + inv + '</td>'
         + '<td style="padding:2px 8px;text-align:right;color:' + col + ';font-weight:600">' + m.w.toFixed(3) + '</td>'
         + '<td style="padding:2px 8px;text-align:center;color:var(--txt3)">' + m.n + '</td>'
         + '<td style="padding:2px 8px;text-align:center;color:var(--txt3)">' + m.tot + '</td></tr>';
  }}
  html += '</table>';
  out.innerHTML = html;
}}

function saveWeightsSnapshot() {{
  const w = _collectRunWeights();
  if (!Object.keys(w).length) {{ alert('Нет обученных весов — сначала запусти бэктест.'); return; }}
  const name = (prompt('Имя снимка весов:') || '').trim();
  if (!name) return;
  fetch('/api/weights_snapshot_save', {{method: 'POST', headers: {{'Content-Type': 'application/json'}}, body: JSON.stringify({{name: name, weights: w}})}})
    .then(r => r.json()).then(d => {{
      if (d.error) {{ alert('Ошибка: ' + d.error); return; }}
      alert('Снимок сохранён: ' + name + ' (' + d.tickers + ' тик.). Бота не трогает.');
      refreshWeightsSnapshots();
    }}).catch(() => {{}});
}}

function refreshWeightsSnapshots() {{
  fetch('/api/weights_snapshots').then(r => r.json()).then(d => {{
    const sel = document.getElementById('weights_snapshot_select');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">— снимок весов —</option>';
    (d.snapshots || []).forEach(s => {{
      const o = document.createElement('option');
      o.value = s.name; o.textContent = s.name + ' (' + (s.tickers || []).length + ' тик.)';
      sel.appendChild(o);
    }});
    if (cur) sel.value = cur;
  }}).catch(() => {{}});
}}

function applyWeightsSnapshotConfirm() {{
  const sel = document.getElementById('weights_snapshot_select');
  if (!sel || !sel.value) {{ alert('Выбери снимок весов из списка.'); return; }}
  const name = sel.value;
  if (!confirm('Применить веса снимка «' + name + '» к БОЕВОМУ боту?\\n\\nЭто перезапишет oi_weights.json — бот начнёт торговать с этими весами.\\nРезервная копия останется в oi_weights.json.bak.\\n\\nТочно применить?')) return;
  fetch('/api/weights_snapshot_apply', {{method: 'POST', headers: {{'Content-Type': 'application/json'}}, body: JSON.stringify({{name: name}})}})
    .then(r => r.json()).then(d => {{
      if (d.error) {{ alert('Ошибка: ' + d.error); return; }}
      alert('Применено к боту: ' + d.applied + ' тик.\\nБэкап: ' + d.backup);
    }}).catch(() => {{}});
}}

// ── Dashboard grid view ──────────────────────────────────────────────────────

let _dashViewActive = false;
let _dgSelectedTicker = null;
let _tcCanvasOrigParent = null;  // куда вернуть канвас при выходе из дашборда

function toggleDashView() {{
  _dashViewActive = !_dashViewActive;
  document.getElementById('results').style.display = _dashViewActive ? 'none' : '';
  document.getElementById('compare_block').style.display = 'none';
  document.getElementById('dash-grid').style.display = _dashViewActive ? 'block' : 'none';
  document.getElementById('btnDashView').textContent = _dashViewActive ? '☰ таблица' : '⊞ дашборд';

  const wrap = document.getElementById('tc_canvas_wrap');
  const chartBody = document.getElementById('dg-chart-body');
  const canvas = document.getElementById('tc_canvas');

  if (_dashViewActive) {{
    // Перемещаем канвас в grid-панель
    _tcCanvasOrigParent = wrap.parentElement;
    chartBody.appendChild(wrap);
    // Растягиваем canvas на всю панель
    canvas.style.height = '100%';
    canvas.style.borderRadius = '6px';
    renderDashGrid();
    // Скроллим к grid-панели и перерисовываем после layout — нужны два RAF,
    // чтобы flex успел раздать размеры до _resize (иначе clientWidth=0).
    setTimeout(() => {{
      document.getElementById('dash-grid').scrollIntoView({{behavior: 'smooth', block: 'start'}});
    }}, 80);
    requestAnimationFrame(() => requestAnimationFrame(() => {{
      if (typeof _resize === 'function') _resize();
    }}));
  }} else {{
    // Возвращаем канвас на место
    if (_tcCanvasOrigParent) _tcCanvasOrigParent.appendChild(wrap);
    canvas.style.height = '480px';
    canvas.style.borderRadius = '10px';
    setTimeout(() => {{ if (typeof _resize === 'function') _resize(); }}, 50);
  }}
}}

async function runSystemBacktest() {{
  const box = document.getElementById('systemResult');
  const allChips = Array.from(document.querySelectorAll('.chip.active'));
  const tickers = allChips.map(c => c.dataset.ticker).filter(Boolean);
  if (tickers.length === 0) {{ alert('Нет активных чипов тикеров. Выбери хотя бы один (системный прогон идёт по выбранным, как обычный бэктест).'); return; }}
  const days = parseInt(document.getElementById('days').value, 10) || 90;
  box.innerHTML = '<span style="color:var(--txt3);font-size:12px;">🧭 Системный прогон '+tickers.length+' тикеров через живые стратегии…</span>';
  try {{
    const resp = await fetch('/api/system_backtest?days='+days+'&tickers='+encodeURIComponent(tickers.join(',')));
    const d = await resp.json();
    if (d.error) {{ box.innerHTML = '<span style="color:var(--neg)">Ошибка: '+d.error+'</span>'; return; }}
    const allRows = (d.rows||[]);
    const skippedRows = allRows.filter(r => r.skipped);
    const rows = allRows.filter(r => !r.skipped).sort((a,b)=> (b.exp_atr!==undefined?b.exp_atr:-9) - (a.exp_atr!==undefined?a.exp_atr:-9));
    const col = v => v>0 ? 'var(--pos)' : v<0 ? 'var(--neg)' : 'var(--txt2)';
    let html = '<div style="font-size:11px;color:var(--txt3);margin-bottom:4px;">'+
      'оценено <b style="color:var(--txt)">'+(d.evaluated||0)+'</b> · пропущено '+(d.skipped||0)+' (нет свечей в кэше) · ошибок '+(d.errored||0)+
      ' &nbsp;|&nbsp; held-out: прогрев='+Math.round(d.split_frac*100)+'% (train), сигналы=OOS · cost='+d.cost_atr+' ATR · '+d.days+'д · exp в ATR/сделку</div>';
    if ((d.evaluated||0) === 0) {{
      html += '<div style="font-size:11px;color:var(--neg);margin-bottom:6px;">Ни один тикер не оценён — нет свечей в кэше. Прогрей кэш обычным бэктестом/«сохранить историю» по этим тикерам, потом повтори системный прогон.</div>';
    }}
    // Свод по стратегиям
    const bs = d.by_strategy||{{}};
    html += '<table style="font-size:11px;border-collapse:collapse;margin-bottom:8px;"><tr style="color:var(--txt3)">'+
      '<th style="text-align:left;padding:2px 8px">стратегия</th><th style="padding:2px 8px">тикеров</th><th style="padding:2px 8px">N</th><th style="padding:2px 8px">win</th><th style="padding:2px 8px">exp ATR</th></tr>';
    for (const [name, a] of Object.entries(bs)) {{
      html += '<tr><td style="padding:2px 8px;font-weight:600">'+name+'</td><td style="text-align:center;padding:2px 8px">'+a.tickers+'</td>'+
        '<td style="text-align:center;padding:2px 8px">'+a.n+'</td><td style="text-align:center;padding:2px 8px">'+(a.win*100).toFixed(0)+'%</td>'+
        '<td style="text-align:center;padding:2px 8px;color:'+col(a.exp_atr)+';font-weight:700">'+(a.exp_atr>=0?'+':'')+a.exp_atr.toFixed(3)+'</td></tr>';
    }}
    html += '</table>';
    // По тикерам
    html += '<table style="font-size:11px;border-collapse:collapse;"><tr style="color:var(--txt3)">'+
      '<th style="text-align:left;padding:2px 8px">тикер</th><th style="padding:2px 8px">стратегия</th><th style="padding:2px 8px">N</th><th style="padding:2px 8px">win</th><th style="padding:2px 8px">exp ATR</th><th style="text-align:left;padding:2px 8px"></th></tr>';
    for (const r of rows) {{
      if (r.error) {{
        html += '<tr><td style="padding:2px 8px">'+r.ticker+'</td><td style="padding:2px 8px;color:var(--txt3)">'+(r.strategy||'')+'</td><td colspan=3></td><td style="padding:2px 8px;color:var(--txt3)">'+r.error+'</td></tr>';
        continue;
      }}
      html += '<tr><td style="padding:2px 8px;font-weight:600">'+r.ticker+'</td><td style="padding:2px 8px;color:var(--txt2)">'+r.strategy+'</td>'+
        '<td style="text-align:center;padding:2px 8px">'+r.n+'</td><td style="text-align:center;padding:2px 8px">'+(r.win*100).toFixed(0)+'%</td>'+
        '<td style="text-align:center;padding:2px 8px;color:'+col(r.exp_atr)+';font-weight:700">'+(r.exp_atr>=0?'+':'')+r.exp_atr.toFixed(3)+'</td><td></td></tr>';
    }}
    html += '</table>';
    if (skippedRows.length) {{
      const names = skippedRows.map(r => r.ticker).join(', ');
      html += '<details style="margin-top:8px;font-size:11px;color:var(--txt3)"><summary style="cursor:pointer">пропущено '+skippedRows.length+' (нет свечей в кэше)</summary>'+
        '<div style="padding:4px 8px;line-height:1.6">'+names+'</div></details>';
    }}
    box.innerHTML = html;
  }} catch (e) {{
    box.innerHTML = '<span style="color:var(--neg)">Сбой запроса: '+e+'</span>';
  }}
}}

function renderDashGrid() {{
  // Итоговая строка
  const valid = _backtestRows.filter(r => r.win_rate !== undefined && (r.n_trades||0) > 0);
  const n = valid.reduce((s,r)=>s+r.n_trades,0);
  const wr = n ? valid.reduce((s,r)=>s+r.win_rate*r.n_trades,0)/n : 0;
  const exp = n ? valid.reduce((s,r)=>s+(r.expectancy_pct||0)*r.n_trades,0)/n : 0;
  const avgR = n ? valid.reduce((s,r)=>s+(r.avg_r||0)*r.n_trades,0)/n : 0;
  const wrColor = wr>0.55?'var(--pos)':wr<0.45?'var(--neg)':'var(--txt2)';
  const expColor = exp>0?'var(--pos)':exp<0?'var(--neg)':'var(--txt2)';
  document.getElementById('dg-summary').innerHTML =
    `<div style="color:var(--txt3);margin-bottom:4px;">Итого ${{valid.length}} тикеров, ${{n}} сделок</div>`+
    `<div>WR <span style="color:${{wrColor}};font-weight:700">${{(wr*100).toFixed(1)}}%</span> &nbsp; avg R <b>${{avgR.toFixed(2)}}</b> &nbsp; Exp <span style="color:${{expColor}}">${{(exp*100).toFixed(2)}}%</span></div>`;

  // Список тикеров
  const hideZero = document.getElementById('hide_zero').checked;
  const minT = parseInt(document.getElementById('min_trades').value)||0;
  let rows = _backtestRows.filter(r=>r.n_trades!==undefined);
  if (hideZero) rows = rows.filter(r=>r.n_trades>0);
  if (minT>0) rows = rows.filter(r=>r.n_trades>=minT);

  let html = '';
  for (const r of rows) {{
    const wr2 = r.win_rate !== undefined ? (r.win_rate*100).toFixed(0)+'%' : '—';
    const wrC = r.win_rate>0.55?'var(--pos)':r.win_rate<0.45?'var(--neg)':'var(--txt2)';
    const sel = r.ticker===_dgSelectedTicker ? 'background:var(--accent2,#1e1a4a);font-weight:700;' : '';
    html += `<div data-ticker="${{r.ticker}}" onclick="dgSelectTicker('${{r.ticker}}')" style="cursor:pointer;padding:5px 12px;display:flex;justify-content:space-between;align-items:center;${{sel}}">`+
      `<span style="font-size:12px;color:var(--mem)">${{r.ticker}}</span>`+
      `<span style="font-size:11px;display:flex;gap:8px;color:var(--txt3)">`+
      `<span style="color:${{wrC}}">${{wr2}}</span>`+
      `<span>${{r.n_trades||0}}</span>`+
      `<span style="color:${{(r.avg_r||0)>0?'var(--pos)':'var(--neg)'}}">${{(r.avg_r||0).toFixed(2)}}R</span>`+
      `</span></div>`;
  }}
  document.getElementById('dg-ticker-list').innerHTML = html;

  // Если был выбран тикер — обновить детали
  if (_dgSelectedTicker) {{
    const r = _backtestRows.find(x=>x.ticker===_dgSelectedTicker);
    if (r) dgShowDetails(r);
  }}
}}

function dgSelectTicker(ticker) {{
  _dgSelectedTicker = ticker;
  // Подсветить выбранную строку
  for (const el of document.querySelectorAll('#dg-ticker-list > div')) {{
    const t = el.dataset.ticker;
    el.style.background = t === ticker ? 'var(--accent2,#1e1a4a)' : '';
    el.style.fontWeight = t === ticker ? '700' : '';
  }}
  const r = _backtestRows.find(x=>x.ticker===ticker);
  if (r) dgShowDetails(r);

  // Грузим график: ставим тикер в дропдаун + дни + вызываем loadTradeChart
  document.getElementById('dg-chart-title').textContent = 'График: ' + ticker + ' (загрузка...)';
  const sel = document.getElementById('tc_ticker');
  let found = false;
  for (const opt of sel.options) {{ if (opt.value===ticker) {{ sel.value=ticker; found=true; break; }} }}
  if (!found) {{
    const opt = new Option(ticker, ticker);
    sel.add(opt);
    sel.value = ticker;
  }}
  loadTradeChart().then(()=>{{
    document.getElementById('dg-chart-title').textContent = 'График: ' + ticker;
    // После загрузки форсируем resize — flex-панель может быть уже растянута,
    // но canvas ещё не знает о своих размерах (особенно при переключении тикера).
    requestAnimationFrame(() => requestAnimationFrame(() => {{
      if (typeof _resize === 'function') _resize();
    }}));
  }}).catch(()=>{{}});
}}

function dgShowDetails(r) {{
  // Сделки
  const hdr = document.getElementById('dg-trades-header');
  const body = document.getElementById('dg-trades-body');
  const n = r.n_trades||0;
  const wr = r.win_rate !== undefined ? (r.win_rate*100).toFixed(1)+'%' : '—';
  const avgR = r.avg_r !== undefined ? r.avg_r.toFixed(2)+'R' : '';
  const exp = r.expectancy_pct !== undefined ? (r.expectancy_pct*100).toFixed(2)+'%' : '';
  hdr.innerHTML = `<b style="color:var(--mem)">${{r.ticker}}</b> &nbsp; ${{n}} сделок &nbsp; WR <b>${{wr}}</b> &nbsp; avg ${{avgR}} &nbsp; exp ${{exp}}`
    + ` &nbsp; <button onclick="copyTicker('${{r.ticker}}', this)" class="btn-pill btn-xs info" style="font-size:9px;padding:1px 8px" title="Вердикт + точность методов + все сделки со всеми методами">📋 копировать тикер</button>`;
  body.innerHTML = r.trades_list && r.trades_list.length
    ? tradesListToHtml(r.trades_list, r.win_rate, r.ticker)
    : '<span style="color:var(--txt3);font-size:11px;padding:8px">Нет данных о сделках</span>';

  // Best/Worst
  const bw = bestWorstTradesToHtml(r.trades_list||[], 7);
  document.getElementById('dg-bestworst-body').innerHTML = bw ||
    '<span style="color:var(--txt3);font-size:11px;padding:8px">Нет данных</span>';

  // Методы + Веса
  const mth = bestWorstMethodsToHtml(r.method_stats);
  const fullMth = r.method_stats ? methodStatsToHtml(r.method_stats) : '';
  document.getElementById('dg-methods-body').innerHTML =
    (mth || '') +
    (fullMth ? `<details style="font-size:10px;margin-top:6px;padding:0 4px" open><summary style="cursor:pointer;color:var(--txt3)">Все методы + веса</summary>${{fullMth}}</details>` : '') ||
    '<span style="color:var(--txt3);font-size:11px;padding:8px">Нет данных</span>';
}}

async function runBacktest() {{
  const allChips = Array.from(document.querySelectorAll('.chip.active'));
  console.log('[runBacktest] active chips:', allChips.length, allChips.map(c=>c.dataset.ticker));
  const allTickers = allChips.map(c => c.dataset.ticker).filter(Boolean);
  if (allTickers.length === 0) {{ alert('Нет активных чипов тикеров. Выбери хотя бы один.'); return; }}
  const table = document.getElementById('results');
  _backtestRows = [];
  _droppedRows = [];
  renderResultsTable();
  const days = parseInt(document.getElementById('days').value, 10);
  const offsetDays = parseInt(document.getElementById('offset_days').value, 10) || 0;
  const atrTake = document.getElementById('atr_take').value;
  const atrStop = document.getElementById('atr_stop').value;

  let filtered;
  try {{
    filtered = await applyDedup(allTickers);
  }} catch(e) {{
    console.error('[runBacktest] applyDedup failed:', e);
    alert('Ошибка фильтрации тикеров: ' + e);
    return;
  }}
  const tickers = filtered.kept;
  if (document.getElementById('reverse_order').checked) {{
    tickers.reverse();
  }}
  _droppedRows = filtered.dropped;
  renderResultsTable();

  document.getElementById('status').textContent =
    `Считаю ${{tickers.length}} тикер(ов) параллельно (до __BACKTEST_WORKERS__ одновременно)...`;
  startProgressPolling(tickers, 'status_detail');
  let doneCount = 0;
  let autoSaved = null;
  try {{
    const resp = await fetch('/api/backtest_stream', {{
      method: 'POST', headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{tickers: tickers, days: days, offset_days: offsetDays, atr_take: atrTake, atr_stop: atrStop,
                              tariff: document.getElementById('tariff').value,
                              adaptive_narrative: document.getElementById('adaptive_narrative').checked,
                              adaptive_lasso: document.getElementById('adaptive_lasso').checked,
                              block_ranging: document.getElementById('block_ranging').checked,
                              disabled_methods: getDisabledMethods(),
                              inverted_methods: getInvertedMethods()}})
    }});
    if (!resp.ok || !resp.body) throw new Error('stream недоступен');
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {{
      const {{done, value}} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {{stream: true}});
      // SSE: каждое событие отделено \n\n
      const parts = buf.split('\\n\\n');
      buf = parts.pop();
      for (const part of parts) {{
        const line = part.startsWith('data: ') ? part.slice(6) : part;
        if (!line.trim()) continue;
        let evt;
        try {{ evt = JSON.parse(line); }} catch(ex) {{ continue; }}
        if (evt.done) {{ autoSaved = {{days: evt.auto_saved_days || 0, trades: evt.auto_saved_trades || 0}}; break; }}
        if (evt.rows) {{
          _backtestRows.push(...evt.rows);
          renderResultsTable();
          renderGlobalMethodStats();
          doneCount++;
          document.getElementById('status').textContent =
            `Готово ${{doneCount}}/${{tickers.length}} тикер(ов)...`;
        }}
      }}
    }}
  }} catch (e) {{
    // Fallback: пробуем забрать кэш если стрим оборвался
    try {{
      const r2 = await fetch('/api/last_result?kind=backtest');
      const d2 = await r2.json();
      if (d2 && d2.rows) {{
        _backtestRows.push(...d2.rows);
        renderResultsTable();
        table.innerHTML += `<tr><td colspan="6" style="color:var(--txt3);">⚠ соединение оборвалось, результат из кэша</td></tr>`;
      }} else {{
        table.innerHTML += `<tr><td colspan="6" class="err">сетевая ошибка: ${{e}}</td></tr>`;
      }}
    }} catch (e2) {{
      table.innerHTML += `<tr><td colspan="6" class="err">сетевая ошибка: ${{e}}</td></tr>`;
    }}
  }} finally {{
    stopProgressPolling();
  }}
  document.getElementById('status').textContent = autoSaved
    ? `Готово: ${{tickers.length}} тикер(ов). Автосохранено в history.json: ${{autoSaved.days}} дн., ${{autoSaved.trades}} сделок.`
    : `Готово: ${{tickers.length}} тикер(ов)`;
  renderGlobalMethodStats();
  // Заполнить панель графика тикерами из только что завершённого бэктеста
  if (tickers.length > 0) {{
    // Первый ATR из сетки — берём первые числа из строк вида "2,3,4"
    const firstTake = parseFloat(atrTake.split(',')[0]) || 2.0;
    const firstStop = parseFloat(atrStop.split(',')[0]) || 1.0;
    tcPopulateTickers(tickers, days, firstTake, firstStop);
  }}
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

async function saveBacktestHistory() {{
  const tickers = Array.from(document.querySelectorAll('.chip.active')).map(c => c.dataset.ticker);
  if (!tickers.length) {{ alert('Выбери тикеры (активные чипы)'); return; }}
  const days = parseInt(document.getElementById('days').value) || 90;
  const offsetDays = parseInt(document.getElementById('offset_days').value, 10) || 0;
  // Сохраняем то, что уже посчитано последним "ЗАПУСТИТЬ БЭКТЕСТ" (сервер
  // держит его в _last_backtest_history_data) — без повторного прогона.
  // Тикеры, для которых кэша нет (бэктест по ним ещё не гоняли в этой
  // сессии сервера), сервер досчитает сам — за тот же период (days/offset_days,
  // как сейчас стоят в форме) — и сообщит об этом в ответе.
  const btn = event.target;
  btn.disabled = true; btn.textContent = '⏳ сохраняю...';
  startProgressPolling(tickers, 'status_detail');
  try {{
    const r = await fetch('/api/save_backtest_history', {{
      method: 'POST', headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{tickers, days, offset_days: offsetDays}})
    }});
    const d = await r.json();
    if (d.error) {{ alert('Ошибка: ' + d.error); }}
    else {{
      const errs = d.errors && d.errors.length ? '\\nОшибки: ' + d.errors.join(', ') : '';
      const recomp = d.recomputed && d.recomputed.length
        ? `\\nДосчитано с нуля (не было в кэше): ${{d.recomputed.join(', ')}}` : '';
      alert(`Сохранено: ${{d.saved_days}} дн., ${{d.trades}} сделок (из кэша: ${{d.from_cache}} тикер(ов)).${{recomp}}${{errs}}`);
    }}
  }} catch(e) {{
    alert('Ошибка: ' + e);
  }} finally {{
    stopProgressPolling();
    document.getElementById('status_detail').textContent = '';
    btn.disabled = false; btn.textContent = '💾 сохранить историю';
  }}
}}

async function runCalibration() {{
  const tickers = Array.from(document.querySelectorAll('.chip.active')).map(c => c.dataset.ticker);
  if (!tickers.length) {{ alert('Выбери тикеры (активные чипы)'); return; }}
  const days = parseInt(document.getElementById('days').value) || 90;
  if (!confirm(`Калибровать narrative/lasso/rule_miner по ${{tickers.length}} тикерам (${{days}} дн.) на уже сохранённой history.json?`)) return;
  const btn = event.target;
  btn.disabled = true; btn.textContent = '⏳ калибрую...';
  startCalibrationPolling('calib_status_detail');
  try {{
    const r = await fetch('/api/run_calibration', {{
      method: 'POST', headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{tickers, days}})
    }});
    const d = await r.json();
    if (d.error) {{ alert('Ошибка: ' + d.error); }}
    else {{
      alert(
        `narrative: ${{d.narrative_pairs}} пар (кластер, режим)\\n` +
        `lasso: ${{d.lasso_tickers}} тикеров\\n` +
        `rule_miner: ${{d.rule_tickers}} тикеров\\n` +
        (d.errors && d.errors.length ? '\\nОшибки: ' + d.errors.join('; ') : '')
      );
    }}
  }} catch(e) {{
    alert('Ошибка: ' + e);
  }} finally {{
    stopProgressPolling();
    document.getElementById('calib_status_detail').textContent = '';
    btn.disabled = false; btn.textContent = '🎯 калибровать (narrative+lasso+rules)';
  }}
}}

async function calibrateAllHistory() {{
  if (!confirm('Калибровать narrative/lasso/rule_miner по ВСЕМ тикерам, уже сохранённым в data/history.json (не только активные чипы)?')) return;
  const btn = event.target;
  btn.disabled = true; btn.textContent = '⏳ калибрую...';
  startCalibrationPolling('calib_status_detail');
  try {{
    const r = await fetch('/api/run_calibration', {{
      method: 'POST', headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{use_all_history: true}})
    }});
    const d = await r.json();
    if (d.error) {{ alert('Ошибка: ' + d.error); }}
    else {{
      alert(
        `Тикеров: ${{(d.tickers_used || []).length}}, окно: ${{d.days_used}} дн.\\n` +
        `narrative: ${{d.narrative_pairs}} пар (кластер, режим)\\n` +
        `lasso: ${{d.lasso_tickers}} тикеров\\n` +
        `rule_miner: ${{d.rule_tickers}} тикеров\\n` +
        (d.errors && d.errors.length ? '\\nОшибки: ' + d.errors.join('; ') : '')
      );
    }}
  }} catch(e) {{
    alert('Ошибка: ' + e);
  }} finally {{
    stopProgressPolling();
    document.getElementById('calib_status_detail').textContent = '';
    btn.disabled = false; btn.textContent = '🎯 калибровать по всей history.json';
  }}
}}

async function reloadFutures() {{
  if (!confirm('Загрузить актуальные контракты из API? Займёт ~10 минут (ограничение Tinkoff).')) return;
  try {{
    const r = await fetch('/api/reload_futures', {{method: 'POST'}});
    const d = await r.json();
    if (d.running && !d.started) {{
      alert('Обновление уже идёт, подождите.');
    }} else {{
      alert('Запущено. Перезагрузи страницу через ~10 минут чтобы увидеть новые контракты.');
    }}
  }} catch(e) {{
    alert('Ошибка: ' + e);
  }}
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
  const REGIME_LABELS = {{
    trending_up: '↑ тренд', trending_down: '↓ тренд',
    ranging: '↔ боковик', high_vol: '⚡ волат.', low_vol: '😴 тихо', stress: '🔴 стресс'
  }};
  const EXIT_LABELS = {{take: '✅ тейк', stop: '🛑 стоп', timeout: '⏱ тайм'}};
  const PATTERN_LABELS = {{
    level_reversal:  '📍уровень',
    false_breakout:  '🪤пробой',
    thread:          '🧵нитка',
  }};
  const PATTERN_BG = {{
    level_reversal: 'rgba(100,200,100,.07)',
    false_breakout: 'rgba(255,190,50,.07)',
    thread:         'rgba(100,180,255,.07)',
  }};
  let html = '';
  trades.forEach((t, i) => {{
    const winColor = t.win ? 'var(--pos)' : 'var(--neg)';
    const netStr = (t.net_pct * 100).toFixed(2) + '%';
    const regime = REGIME_LABELS[t.regime] || t.regime || '—';
    const exitLbl = EXIT_LABELS[t.exit_reason] || t.exit_reason || '—';
    const agreeStr = t.agree_count !== undefined ? `${{t.agree_count}}↑ ${{t.against_count}}↓` : '';
    const patternLbl = PATTERN_LABELS[t.pattern] || '';
    const rowBg = PATTERN_BG[t.pattern] || '';
    const detailId = `td_${{i}}`;
    html += `<tr style="cursor:pointer;${{rowBg ? 'background:'+rowBg : ''}}" onclick="toggleTd('${{detailId}}')">
      <td>${{t.entry_time ? t.entry_time.toString().slice(0,16) : ''}}</td>
      <td>${{t.ticker}}${{t.atr_k ? ' <span style="color:var(--txt3)">'+t.atr_k+'</span>' : ''}}</td>
      <td>${{t.direction === 'LONG' ? '▲ LONG' : '▼ SHORT'}}</td>
      <td style="color:${{winColor}};font-weight:700">${{t.win ? '+' : ''}}${{netStr}}</td>
      <td style="color:${{winColor}}">${{(+t.r_multiple).toFixed(2)}}R</td>
      <td>${{exitLbl}}</td>
      <td style="color:var(--txt3)">${{regime}}</td>
      <td style="color:var(--txt3)">${{agreeStr}}</td>
      <td>${{patternLbl}}</td>
      <td>${{t.pnl_rub ?? ''}}</td>
    </tr>
    <tr id="${{detailId}}" style="display:none">
      <td colspan="10" style="background:rgba(255,255,255,.03);padding:8px 14px;font-size:11px;">
        ${{tradeDetailHtml(t)}}
      </td>
    </tr>`;
  }});
  return html;
}}

function toggleTd(id) {{
  const el = document.getElementById(id);
  if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
}}

function tradeDetailHtml(t) {{
  const fmtScore = v => v >= 0 ? `<span style="color:var(--pos)">+${{v.toFixed(2)}}</span>` : `<span style="color:var(--neg)">${{v.toFixed(2)}}</span>`;
  const PATTERN_FULL = {{
    level_reversal: '📍 Разворот у уровня',
    false_breakout: '🪤 Ложный пробой',
    thread:         '🧵 Нитка',
  }};
  let html = `<div style="display:flex;gap:24px;flex-wrap:wrap">`;
  if (t.pattern && PATTERN_FULL[t.pattern]) {{
    html += `<div style="font-weight:700">${{PATTERN_FULL[t.pattern]}}</div>`;
  }}
  html += `<div><b>Цены:</b> вход ${{t.entry_price}} → выход ${{t.exit_price}} &nbsp; тейк ${{t.take_price}} стоп ${{t.stop_price}}</div>`;
  html += `<div><b>Экспозиция:</b> ${{Math.round(t.duration_min)}} мин</div>`;
  if (t.top_agree && t.top_agree.length) {{
    html += `<div><b>За (${{t.agree_count}}):</b> `;
    html += t.top_agree.map(([n, v]) => `${{n}} ${{fmtScore(v)}}`).join(' · ');
    html += `</div>`;
  }}
  if (t.top_against && t.top_against.length) {{
    html += `<div><b>Против (${{t.against_count}}):</b> `;
    html += t.top_against.map(([n, v]) => `${{n}} ${{fmtScore(v)}}`).join(' · ');
    html += `</div>`;
  }}
  if (t.l1_pct != null) {{
    const pct = Math.round(t.l1_pct * 100);
    const pctColor = t.direction === 'LONG'
      ? (pct > 70 ? 'var(--neg)' : pct < 30 ? 'var(--pos)' : 'var(--txt3)')
      : (pct < 30 ? 'var(--neg)' : pct > 70 ? 'var(--pos)' : 'var(--txt3)');
    const maStr = t.l1_above_ma50 ? '▲MA50' : '▼MA50';
    const trendStr = t.l1_trending_up ? ' тренд↑' : t.l1_trending_down ? ' тренд↓' : '';
    const exStr = t.atr_ex_ratio != null
      ? ` ATR-ex <b style="color:${{t.atr_ex_ratio > 0.6 ? 'var(--neg)' : 'var(--txt3)'}}">${{t.atr_ex_ratio.toFixed(2)}}</b>`
      : '';
    html += `<div style="font-size:10px;color:var(--txt3)"><b>L1:</b> `
      + `перцентиль <b style="color:${{pctColor}}">${{pct}}%</b> `
      + `${{maStr}}${{trendStr}}${{exStr}}</div>`;
  }}
  html += `</div>`;
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
  startProgressPolling(tickers, 'pf_status_detail');
  let data;
  let recovered = false;
  try {{
    const resp = await fetch('/api/portfolio_sim', {{method: 'POST', headers: {{'Content-Type': 'application/json'}}, body: JSON.stringify(body)}});
    data = await resp.json();
  }} catch (e) {{
    // Соединение могло оборваться уже ПОСЛЕ того как сервер досчитал
    // результат (прогресс по тикерам дошёл до "готово"), но не успел
    // отправить ответ — забираем его из кэша вместо тихого падения.
    try {{
      const r2 = await fetch('/api/last_result?kind=portfolio_sim');
      data = await r2.json();
      recovered = !!(data && data.summary);
    }} catch (e2) {{
      data = null;
    }}
    if (!recovered) {{
      stopProgressPolling();
      document.getElementById('pf_status').textContent = `сетевая ошибка: ${{e}}`;
      return;
    }}
  }} finally {{
    stopProgressPolling();
  }}
  document.getElementById('pf_status').textContent = recovered
    ? '⚠ соединение оборвалось, результат восстановлен из кэша' : '';

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

  let trh = '<tr><th>Время входа</th><th>Тикер</th><th>Напр.</th><th>Net%</th><th>R</th><th>Выход</th><th>Режим</th><th>За/Против</th><th>P&L ₽</th></tr>';
  trh += pfRowsToHtml(data.trades);
  for (const e of (data.errors || [])) {{
    trh += `<tr><td colspan="8" class="err">${{e.ticker}}: ${{e.error}}</td></tr>`;
  }}
  document.getElementById('pf_trades').innerHTML = trh;
}}

function ovRowHtml(ticker, t, oiInfo) {{
  t = t || {{}};
  const en = t.enabled !== false;
  const so = t.signal_only === true ? 'sandbox' : (t.signal_only === false ? 'live' : 'auto');
  // oiInfo задан только для тикеров, которые держатся ИСКЛЮЧИТЕЛЬНО на старом
  // импорте oi_tickers.json (не в settings.ini, не резолвятся как фьючерс) —
  // для settings.ini/[FUTURES_TRADING] удалять нечего, они появятся заново.
  let srcBadge, delBtn = '';
  if (oiInfo) {{
    const cacheNote = oiInfo.has_cache ? '' : ' — нет локального кэша свечей (никогда не считался)';
    srcBadge = `<span title="Только импорт oi_tickers.json (oi-signal-v10.html), не в settings.ini${{cacheNote}}" style="font-size:8px;padding:0 4px;border:1px solid #a05a2c;border-radius:6px;color:#d08a4a;white-space:nowrap">OI-импорт${{oiInfo.has_cache ? '' : ' ✗'}}</span>`;
    delBtn = `<button onclick="removeOiTicker('${{ticker}}', this)" title="Убрать из oi_tickers.json — тикер держится только на старом импорте" style="font-size:10px;padding:1px 6px;border:1px solid var(--border2);border-radius:4px;background:transparent;color:var(--txt3);cursor:pointer;margin-left:4px">🗑</button>`;
  }} else {{
    srcBadge = `<span title="Из settings.ini или резолвится как фьючерс [FUTURES_TRADING]" style="font-size:8px;padding:0 4px;border:1px solid var(--border2);border-radius:6px;color:var(--txt3)">ini</span>`;
  }}
  return `<tr data-ticker="${{ticker}}">
    <td>${{ticker}} ${{srcBadge}}${{delBtn}}</td>
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

function removeOiTicker(ticker, btn) {{
  if (!confirm(`Убрать «${{ticker}}» из oi_tickers.json? Он больше не будет появляться в списках, пока не импортируешь заново.`)) return;
  fetch('/api/oi_ticker_remove', {{method: 'POST', headers: {{'Content-Type': 'application/json'}}, body: JSON.stringify({{ticker: ticker}})}})
    .then(r => r.json()).then(d => {{
      if (!d.ok) {{ alert('ошибка: ' + (d.error || '?')); return; }}
      const row = document.querySelector(`#ov_table tr[data-ticker="${{ticker}}"]`);
      if (row) row.remove();
    }}).catch(() => alert('ошибка сети'));
}}

function pruneStaleOiTickers() {{
  if (!confirm('Убрать из oi_tickers.json все тикеры без settings.ini/[FUTURES_TRADING] И без локального кэша свечей (ни разу не считались на этой машине)?')) return;
  fetch('/api/oi_tickers_prune_stale', {{method: 'POST', headers: {{'Content-Type': 'application/json'}}, body: '{{}}'}})
    .then(r => r.json()).then(d => {{
      if (!d.ok) {{ alert('ошибка'); return; }}
      alert(`Убрано: ${{d.count}}` + (d.count ? `\\n${{d.removed.join(', ')}}` : ''));
      loadOverrides();
    }}).catch(() => alert('ошибка сети'));
}}

async function pruneFailedOiTickers() {{
  // Читаем актуальный прогресс с сервера, не из DOM — таблица прогресса
  // рендерится в разных местах (главный прогон / калибровка / weekly), но
  // /api/progress один. Так надёжнее: работает даже если пользователь
  // сейчас на другой вкладке.
  const failedStatuses = new Set(['нет истории', 'ошибка API', 'ошибка']);
  let progress = {{}};
  try {{
    const r = await fetch('/api/progress');
    progress = await r.json();
  }} catch(e) {{
    alert('не удалось прочитать /api/progress'); return;
  }}
  const snap = {{}};
  for (const tk in progress) {{
    const st = (progress[tk] && progress[tk].status) || '';
    if (failedStatuses.has(st)) snap[tk] = st;
  }}
  const n = Object.keys(snap).length;
  if (!n) {{
    alert('В последнем прогоне нет тикеров со статусом «нет истории»/«ошибка API»/«ошибка». Сначала запусти прогон бэктеста — тогда статусы попадут в /api/progress.');
    return;
  }}
  const list = Object.keys(snap).sort().join(', ');
  if (!confirm(`Убрать из oi_tickers.json ${{n}} тикеров, упавших в последнем прогоне?\\n\\n${{list}}\\n\\nТикеры, сконфигурированные в settings.ini/[FUTURES_TRADING], не тронутся — их надо удалять оттуда вручную.`)) return;
  fetch('/api/oi_tickers_prune_failed', {{method: 'POST', headers: {{'Content-Type': 'application/json'}}, body: JSON.stringify({{statuses: snap}})}})
    .then(r => r.json()).then(d => {{
      if (!d.ok) {{ alert('ошибка'); return; }}
      const parts = [];
      const rmOi = d.removed_from_oi || [];
      const disOv = d.disabled_in_overrides || [];
      const alr = d.already_disabled || [];
      const unk = d.unknown_source || [];
      if (rmOi.length) parts.push(`Удалено из oi_tickers.json (${{rmOi.length}}):\\n  ${{rmOi.join(', ')}}`);
      if (disOv.length) parts.push(`Выключено enabled=false в overrides (settings.ini, ${{disOv.length}}):\\n  ${{disOv.join(', ')}}`);
      if (alr.length) parts.push(`Уже отключены (пропущено, ${{alr.length}}):\\n  ${{alr.join(', ')}}`);
      if (unk.length) parts.push(`Неизвестный источник (не в oi_tickers и не в settings.ini, ${{unk.length}}):\\n  ${{unk.join(', ')}}`);
      alert(parts.length ? parts.join('\\n\\n') : 'Ничего не изменилось.');
      loadOverrides();
    }}).catch(() => alert('ошибка сети'));
}}

async function loadBotStatus() {{
  const data = await fetch('/api/bot_status').then(r => r.json()).catch(() => ({{running: false}}));
  const dot = document.getElementById('bot_state_dot');
  const lbl = document.getElementById('bot_state_label');
  const btnP = document.getElementById('btn_pause');
  const btnR = document.getElementById('btn_resume');
  if (!data.running) {{
    dot.className = 'sdot err'; lbl.textContent = 'Бот не запущен / нет данных';
    btnP.style.display = 'none'; btnR.style.display = 'none';
  }} else if (data.paused) {{
    dot.className = 'sdot err'; lbl.textContent = '⏸ Пауза — новые позиции не открываются';
    btnP.style.display = 'none'; btnR.style.display = '';
  }} else {{
    dot.className = 'sdot ok'; lbl.textContent = '▶ Торговля активна';
    btnP.style.display = ''; btnR.style.display = 'none';
  }}
  if (data.updated_at) lbl.title = 'обновлено: ' + data.updated_at;

  // Риск-панель
  const riskDiv = document.getElementById('bot_risk');
  if (data.risk) {{
    const r = data.risk;
    const dailyStop = r.daily_stop_hit
      ? `<span style="color:var(--neg);font-weight:700">🛑 ДНЕВНОЙ СТОП</span>`
      : `<span style="color:var(--pos)">✓ в норме</span>`;
    const pnlColor = r.day_pnl_rub >= 0 ? 'var(--pos)' : 'var(--neg)';
    const cooldownTickers = Object.keys(data.cooldowns || {{}});
    const cooldownStr = cooldownTickers.length
      ? `<span style="color:var(--neg)"> · кулдаун: ${{cooldownTickers.join(', ')}}</span>` : '';
    riskDiv.innerHTML =
      `<span>Портфельный риск: <b>${{r.portfolio_risk_pct}}%</b></span> &nbsp;·&nbsp; ` +
      `<span>P&amp;L за день: <b style="color:${{pnlColor}}">${{r.day_pnl_rub >= 0 ? '+' : ''}}${{r.day_pnl_rub.toFixed(0)}}₽</b></span> &nbsp;·&nbsp; ` +
      `<span>Сделок сегодня: <b>${{r.trades_today}}</b></span> &nbsp;·&nbsp; ` +
      `<span>Дневной стоп: ${{dailyStop}}</span>${{cooldownStr}}`;
    riskDiv.style.display = '';
  }} else {{
    riskDiv.style.display = 'none';
  }}

  // Открытые позиции
  const posDiv = document.getElementById('bot_positions');
  const sel = document.getElementById('close_ticker_sel');
  if (!data.positions || data.positions.length === 0) {{
    posDiv.textContent = 'Открытых позиций нет.';
    sel.innerHTML = '<option value="ALL">ALL (все)</option>';
  }} else {{
    posDiv.innerHTML = data.positions.map(p => {{
      const pnl = p.cur_pnl_pct !== undefined ? ` <span style="color:${{p.cur_pnl_pct >= 0 ? 'var(--pos)' : 'var(--neg)'}}">${{p.cur_pnl_pct >= 0 ? '+' : ''}}${{p.cur_pnl_pct?.toFixed(2)}}%</span>` : '';
      const mfe = p.mfe_pct !== undefined ? ` &nbsp;пик <span style="color:var(--pos)">+${{p.mfe_pct.toFixed(2)}}%</span>` : '';
      const mae = p.mae_pct !== undefined ? ` просадка <span style="color:var(--neg)">-${{p.mae_pct.toFixed(2)}}%</span>` : '';
      const levels = p.take ? ` <span style="color:var(--txt3)">тейк ${{p.take}} · стоп ${{p.stop}}</span>` : '';
      return `<div style="margin:3px 0;padding:5px 10px;background:var(--card);border-radius:8px;border:1px solid var(--border);display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
        <b style="color:var(--txt)">${{p.ticker}}</b>
        <span style="color:var(--txt3)">${{p.direction}}</span>
        ${{pnl}}${{mfe}}${{mae}}
        ${{p.entry_price ? `<span style="color:var(--txt3)">вход ${{p.entry_price}} → ${{p.cur_price}}</span>` : ''}}
        ${{levels}}
      </div>`;
    }}).join('');
    const tickers = ['ALL', ...data.positions.map(p => p.ticker)];
    sel.innerHTML = tickers.map(t => `<option value="${{t}}">${{t}}</option>`).join('');
  }}

  // Сделки дня
  const closedDiv = document.getElementById('bot_closed_today');
  if (data.closed_today && data.closed_today.length > 0) {{
    closedDiv.innerHTML = `<div class="sec" style="margin:14px 0 6px;">Закрытые сделки сегодня (${{data.closed_today.length}})</div>` +
      data.closed_today.map(t => {{
        const dir = t.direction === 'LONG'
          ? `<span style="color:var(--pos)">LONG</span>`
          : `<span style="color:var(--neg)">SHORT</span>`;
        return `<div style="margin:2px 0;padding:3px 10px;background:var(--card);border-radius:6px;border:1px solid var(--border);font-size:11px;">
          <b>${{t.ticker}}</b> ${{dir}} · тейк ${{t.take}} · стоп ${{t.stop}}
        </div>`;
      }}).join('');
    closedDiv.style.display = '';
  }} else {{
    closedDiv.style.display = 'none';
  }}

  // Пропущенные сигналы
  let skipDiv = document.getElementById('bot_skipped_signals');
  if (!skipDiv) {{
    skipDiv = document.createElement('div');
    skipDiv.id = 'bot_skipped_signals';
    closedDiv.insertAdjacentElement('afterend', skipDiv);
  }}
  if (data.skipped_signals && data.skipped_signals.length > 0) {{
    skipDiv.innerHTML = `<div class="sec" style="margin:14px 0 6px;">Пропущенные сигналы (${{data.skipped_signals.length}})</div>` +
      data.skipped_signals.slice().reverse().map(s => {{
        const dir = s.direction === 'LONG'
          ? `<span style="color:var(--pos)">LONG</span>`
          : `<span style="color:var(--neg)">SHORT</span>`;
        return `<div style="margin:2px 0;padding:3px 10px;background:var(--card);border-radius:6px;border:1px solid var(--border);font-size:11px;">
          <b>${{s.ticker}}</b> ${{dir}} · ${{s.reason}} · ${{s.at}}
        </div>`;
      }}).join('');
    skipDiv.style.display = '';
  }} else {{
    skipDiv.style.display = 'none';
  }}
}}

// ── Живой график сделок ────────────────────────────────────────────────────

let _lcChart = null;  // Canvas 2D context

function _lcDrawChart(candles, trades) {{
  const canvas = document.getElementById('lc_canvas');
  const placeholder = document.getElementById('lc_placeholder');
  if (!candles || !candles.length) {{
    placeholder.textContent = 'Нет свечей'; placeholder.style.display = '';
    canvas.style.display = 'none'; return;
  }}
  placeholder.style.display = 'none';
  canvas.style.display = 'block';
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Цены min/max
  let lo = Infinity, hi = -Infinity;
  for (const c of candles) {{ lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }}
  // Маркеры входа/стопа/тейка
  for (const t of (trades || [])) {{
    if (t.entry_price) {{ lo = Math.min(lo, t.entry_price); hi = Math.max(hi, t.entry_price); }}
    if (t.stop_price)  {{ lo = Math.min(lo, t.stop_price);  hi = Math.max(hi, t.stop_price); }}
    if (t.take_price)  {{ lo = Math.min(lo, t.take_price);  hi = Math.max(hi, t.take_price); }}
  }}
  const pad = (hi - lo) * 0.05 || 1;
  lo -= pad; hi += pad;
  const scaleY = (price) => H - ((price - lo) / (hi - lo)) * H;

  const n = candles.length;
  const marginLeft = 52, marginRight = 8;
  const chartW = W - marginLeft - marginRight;
  const candleW = Math.max(2, Math.floor(chartW / n) - 1);
  const scaleX = (i) => marginLeft + (i + 0.5) * chartW / n;

  // Фон
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--card').trim() || '#16161e';
  ctx.fillRect(0, 0, W, H);

  // Сетка
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
  for (let gi = 0; gi <= 4; gi++) {{
    const y = Math.round(H * gi / 4) + 0.5;
    ctx.beginPath(); ctx.moveTo(marginLeft, y); ctx.lineTo(W - marginRight, y); ctx.stroke();
    const price = hi - (hi - lo) * gi / 4;
    ctx.fillStyle = '#666'; ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(price.toFixed(2), marginLeft - 2, y + 3);
  }}

  // Свечи
  for (let i = 0; i < n; i++) {{
    const c = candles[i];
    const x = Math.round(scaleX(i));
    const isUp = c.c >= c.o;
    const color = isUp ? '#26a37b' : '#e05260';
    ctx.strokeStyle = color; ctx.fillStyle = color;
    // Тень
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, Math.round(scaleY(c.h)));
    ctx.lineTo(x, Math.round(scaleY(c.l)));
    ctx.stroke();
    // Тело
    const yO = Math.round(scaleY(c.o)), yC = Math.round(scaleY(c.c));
    const top = Math.min(yO, yC), bodyH = Math.max(1, Math.abs(yC - yO));
    ctx.fillRect(Math.round(x - candleW / 2), top, candleW, bodyH);
  }}

  // Горизонтальные линии сделок
  const times = candles.map(c => new Date(c.t).getTime());
  function timeToX(ts) {{
    const t = new Date(ts).getTime();
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i]-t) < Math.abs(times[best]-t)) best = i;
    return scaleX(best);
  }}

  for (const t of (trades || [])) {{
    const x0 = t.entry_time ? timeToX(t.entry_time) : marginLeft;
    const x1 = t.exit_time  ? timeToX(t.exit_time)  : W - marginRight;
    const isLong = (t.direction || '').toLowerCase() === 'long';

    if (t.take_price) {{
      ctx.setLineDash([4,3]); ctx.strokeStyle = '#26a37b'; ctx.lineWidth = 1;
      const y = Math.round(scaleY(t.take_price));
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    }}
    if (t.stop_price) {{
      ctx.setLineDash([4,3]); ctx.strokeStyle = '#e05260'; ctx.lineWidth = 1;
      const y = Math.round(scaleY(t.stop_price));
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    }}
    ctx.setLineDash([]);

    if (t.entry_price) {{
      const y = Math.round(scaleY(t.entry_price));
      // Треугольник входа
      ctx.fillStyle = isLong ? '#26a37b' : '#e05260';
      ctx.beginPath();
      if (isLong) {{ ctx.moveTo(x0-5, y+6); ctx.lineTo(x0+5, y+6); ctx.lineTo(x0, y); }}
      else         {{ ctx.moveTo(x0-5, y-6); ctx.lineTo(x0+5, y-6); ctx.lineTo(x0, y); }}
      ctx.closePath(); ctx.fill();
    }}
    if (t.exit_price) {{
      const y = Math.round(scaleY(t.exit_price));
      const win = t.pnl_rub != null ? t.pnl_rub >= 0 : t.win;
      ctx.fillStyle = win ? '#26a37b' : '#e05260';
      ctx.beginPath(); ctx.arc(x1, y, 4, 0, 2*Math.PI); ctx.fill();
    }}
  }}
}}

function _lcInitTickers() {{
  const sel = document.getElementById('lc_ticker');
  if (sel.options.length > 1) return;
  const chips = document.querySelectorAll('.chip');
  const tickers = Array.from(chips).map(c => c.dataset.ticker || c.textContent.trim()).filter(Boolean);
  sel.innerHTML = tickers.length
    ? tickers.map(t => `<option value="${{t}}">${{t}}</option>`).join('')
    : '<option value="">—</option>';
}}

async function loadLiveChart() {{
  const ticker = document.getElementById('lc_ticker').value;
  const days   = document.getElementById('lc_days').value;
  if (!ticker) return;
  const status = document.getElementById('lc_status');
  status.textContent = 'загрузка...';
  try {{
    const data = await fetch(`/api/live_chart?ticker=${{encodeURIComponent(ticker)}}&days=${{days}}`).then(r=>r.json());
    if (data.error) {{ status.textContent = '⚠ ' + data.error; return; }}
    status.textContent = `${{data.candles?.length||0}} свечей · ${{data.trades?.length||0}} сделок`;
    _lcDrawChart(data.candles, data.trades);

    // Список сделок
    const list = document.getElementById('lc_trades_list');
    if (data.trades && data.trades.length) {{
      list.innerHTML = data.trades.slice().reverse().map(t => {{
        const pnlRub = t.pnl_rub != null ? `<span style="color:${{t.pnl_rub>=0?'var(--pos)':'var(--neg)'}}">${{t.pnl_rub>=0?'+':''}}${{t.pnl_rub?.toFixed(0)}}₽</span>` : '';
        const pnlPct = t.net_pct != null ? ` (${{t.net_pct>=0?'+':''}}${{t.net_pct?.toFixed(2)}}%)` : '';
        const dir = (t.direction||'').toLowerCase()==='long'
          ? '<span style="color:var(--pos)">▲ LONG</span>'
          : '<span style="color:var(--neg)">▼ SHORT</span>';
        const ts = (t.entry_time||'').slice(5,16).replace('T',' ');
        return `<div style="padding:3px 8px;margin:2px 0;background:var(--card);border-radius:6px;border:1px solid var(--border2);display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
          <span style="color:var(--txt3)">${{ts}}</span>
          ${{dir}} ${{pnlRub}}${{pnlPct}}
          <span style="color:var(--txt3);font-size:10px;">вход ${{t.entry_price?.toFixed(2)||'—'}} · стоп ${{t.stop_price?.toFixed(2)||'—'}} · тейк ${{t.take_price?.toFixed(2)||'—'}}</span>
        </div>`;
      }}).join('');
    }} else {{
      list.innerHTML = '<span style="color:var(--txt3)">Сделок пока нет</span>';
    }}
  }} catch(e) {{ status.textContent = '⚠ ' + e; }}
}}

async function loadCouncilLog() {{
  try {{
    const data = await fetch('/api/council_log').then(r=>r.json());
    const el = document.getElementById('live_council');
    if (!data.lessons || !data.lessons.length) {{
      el.innerHTML = '<span style="color:var(--txt3)">Диалогов консилиума пока нет</span>'; return;
    }}
    el.innerHTML = data.lessons.slice().reverse().map(l => {{
      const verdict = l.verdict === 'trade'
        ? '<span style="color:var(--pos);font-weight:700">✓ ТОРГОВАТЬ</span>'
        : '<span style="color:var(--neg);font-weight:700">✗ ПРОПУСТИТЬ</span>';
      const ts = (l.ts||'').slice(5,16).replace('T',' ');
      const lesson = (l.lesson||'').slice(0,250);
      return `<div style="padding:6px 8px;margin:3px 0;background:var(--card);border-radius:6px;border:1px solid var(--border2);">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:3px;">
          <span style="color:var(--txt3);font-size:10px;">${{ts}}</span>
          <b style="color:var(--mem)">${{l.ticker||'?'}}</b>
          <span style="color:var(--txt3)">${{l.direction||''}}</span>
          ${{verdict}}
          <span style="color:var(--txt3);font-size:10px;">режим: ${{l.regime||'?'}}</span>
        </div>
        <div style="color:var(--txt2);font-size:10px;line-height:1.4;">${{lesson}}</div>
      </div>`;
    }}).join('');
  }} catch(e) {{
    document.getElementById('live_council').textContent = '⚠ ' + e;
  }}
}}

// ── суб-табы внутри БОТ (LIVE) ──────────────────────────────────────
function liveSub(name) {{
  ['ctrl','cfg','chart','council','oi'].forEach(n => {{
    const el = document.getElementById('live-sub-' + n);
    const btn = document.getElementById('live-sub-btn-' + n);
    if (el) el.style.display = n === name ? '' : 'none';
    if (btn) btn.style.opacity = n === name ? '1' : '.5';
  }});
  // подгружаем данные при первом открытии
  if (name === 'chart') {{ _lcInitTickers(); loadLiveScorecard(); }}
  if (name === 'council') loadCouncilLog();
  if (name === 'oi') {{ oiBackfillStatus(); refreshMoexTokenStatus(); }}
}}

// ── Токен MOEX AlgoPack ──────────────────────────────────────────────
function refreshMoexTokenStatus() {{
  fetch('/api/moex_token_status').then(r => r.json()).then(d => {{
    const el = document.getElementById('moex_token_status');
    if (!el) return;
    el.textContent = d.configured
      ? `✓ настроен (${{d.masked}}, источник: ${{d.source}})`
      : '⚠ токен не задан';
    el.style.color = d.configured ? 'var(--pos, #7dcc7d)' : 'var(--neg, #e07070)';
  }}).catch(() => {{}});
}}

function toggleMoexTokenVisible() {{
  const inp = document.getElementById('moex_token_input');
  if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
}}

function saveMoexToken() {{
  const inp = document.getElementById('moex_token_input');
  const msg = document.getElementById('moex_token_msg');
  const token = (inp?.value || '').trim();
  if (!token) {{ if (msg) msg.textContent = 'введи новый токен'; return; }}
  fetch('/api/moex_token_save', {{method: 'POST', headers: {{'Content-Type': 'application/json'}}, body: JSON.stringify({{token: token}})}})
    .then(r => r.json()).then(d => {{
      if (d.error) {{ if (msg) msg.textContent = 'ошибка: ' + d.error; return; }}
      if (msg) msg.textContent = 'сохранён (' + d.masked + ')' + (d.warning ? ' — ⚠ ' + d.warning : '');
      if (inp) inp.value = '';
      refreshMoexTokenStatus();
    }}).catch(() => {{ if (msg) msg.textContent = 'ошибка сети'; }});
}}

// ── Bulk-действия для таблицы тикеров ───────────────────────────────
function ovBulk(field, value) {{
  const tbody = document.getElementById('ov_table');
  if (!tbody) return;
  const rows = tbody.querySelectorAll('tr');
  rows.forEach(row => {{
    if (field === 'enabled') {{
      const cb = row.querySelector('input[type=checkbox][id^=ov_en_]');
      if (cb) cb.checked = value;
    }} else if (field === 'signal_only') {{
      const sel = row.querySelector('select[id^=ov_so_]');
      if (sel) sel.value = value ? '1' : '0';
    }}
  }});
}}

// ── OI Backfill ──────────────────────────────────────────────────────
async function oiBackfill() {{
  const months  = document.getElementById('oi_bf_months').value;
  const tickers = document.getElementById('oi_bf_tickers').value.trim();
  const status  = document.getElementById('oi_bf_status');
  const btn     = document.getElementById('oi_bf_btn');
  status.textContent = '⏳ запускаю в фоне...';
  if (btn) btn.disabled = true;
  try {{
    const body = {{ months: parseInt(months) }};
    if (tickers) body.tickers = tickers;
    const data = await fetch('/api/oi_backfill', {{
      method: 'POST',
      headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify(body),
    }}).then(r => r.json());
    if (data.error) {{ status.textContent = '⚠ ' + data.error; if(btn) btn.disabled=false; return; }}
    if (!data.started) {{ status.textContent = '⚠ ' + (data.error || 'не удалось запустить'); if(btn) btn.disabled=false; return; }}
    status.textContent = `⏳ запущен для тикеров: ${{(data.tickers||[]).join(', ')}}. Проверяй статус кнопкой ⟳`;
    // авто-опрос каждые 5 сек
    const poll = setInterval(async () => {{
      const s = await fetch('/api/oi_backfill_status').then(r=>r.json());
      if (s.running) {{
        status.textContent = `⏳ в процессе... (записей: ${{s.total_new||0}})`;
      }} else {{
        clearInterval(poll);
        if(btn) btn.disabled = false;
        if (s.error) {{ status.textContent = '⚠ Ошибка: ' + s.error; return; }}
        const log = document.getElementById('oi_bf_log');
        status.textContent = `✅ готово: +${{s.total_new||0}} новых записей`;
        if (s.log && s.log.length) {{
          log.innerHTML = s.log.map(l => `<div>${{l}}</div>`).join('');
          log.style.display = '';
        }}
      }}
    }}, 5000);
  }} catch(e) {{ status.textContent = '⚠ ' + e; if(btn) btn.disabled=false; }}
}}

// Забрать уже собранный ОИ из воркера (D1) в локальный data/oi_daily.json.
async function oiSyncWorker() {{
  const tickers = document.getElementById('oi_bf_tickers').value.trim();
  const status  = document.getElementById('oi_bf_status');
  const btn     = document.getElementById('oi_sync_btn');
  status.textContent = '⚡ тяну из воркера...';
  if (btn) btn.disabled = true;
  try {{
    const body = {{}};
    if (tickers) body.tickers = tickers;
    const d = await fetch('/api/oi_sync_worker', {{
      method: 'POST', headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify(body),
    }}).then(r => r.json());
    if (!d.ok) {{ status.textContent = '⚠ ' + (d.error || 'не удалось'); return; }}
    status.textContent = `✅ из воркера: ${{d.total}} дней всего`;
    const log = document.getElementById('oi_bf_log');
    if (log && d.log && d.log.length) {{
      log.innerHTML = d.log.map(l => `<div>${{l}}</div>`).join('');
      log.style.display = '';
    }}
  }} catch(e) {{ status.textContent = '⚠ ' + e; }}
  finally {{ if (btn) btn.disabled = false; }}
}}

// Диагностика: что лежит в воркере и матчатся ли наши тикеры.
async function oiWorkerCatalog() {{
  const tickers = document.getElementById('oi_bf_tickers').value.trim();
  const status  = document.getElementById('oi_bf_status');
  const log     = document.getElementById('oi_bf_log');
  const btn     = document.getElementById('oi_cat_btn');
  status.textContent = '🔎 спрашиваю воркер...';
  if (btn) btn.disabled = true;
  try {{
    const body = {{}};
    if (tickers) body.tickers = tickers;
    const d = await fetch('/api/oi_worker_catalog', {{
      method: 'POST', headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify(body),
    }}).then(r => r.json());
    if (!d.ok) {{ status.textContent = '⚠ ' + (d.error || 'не удалось'); return; }}
    status.textContent = `в воркере ${{d.catalog_n}} тикеров (кодов) в oi_daily`;
    let html = '<div style="font-weight:600;margin:4px 0">Матч под наши тикеры:</div>';
    html += (d.probes || []).map(p =>
      `<div>${{p.matched ? '✅' : '❌'}} ${{p.ticker}} <span style="color:var(--txt3)">корень ${{p.root}}</span> → ` +
      (p.matched ? `${{p.src}} · ${{p.days}} дн.` : 'нет в воркере') +
      (p.error ? ' <span style="color:#e07070">'+p.error+'</span>' : '') + `</div>`).join('');
    html += '<div style="font-weight:600;margin:8px 0 4px">Всё, что есть в воркере (код · дней · период):</div>';
    html += (d.catalog || []).map(c =>
      `<div style="color:var(--txt3)">${{c.ticker}} · ${{c.days}} · ${{c.from_date||'?'}}→${{c.to_date||'?'}}</div>`).join('');
    if (log) {{ log.innerHTML = html; log.style.display = ''; }}
  }} catch(e) {{ status.textContent = '⚠ ' + e; }}
  finally {{ if (btn) btn.disabled = false; }}
}}

async function oiBackfillStatus() {{
  const status = document.getElementById('oi_bf_status');
  try {{
    const s = await fetch('/api/oi_backfill_status').then(r=>r.json());
    if (!s || !s.running && !s.done) {{ status.textContent = 'Не запущено'; return; }}
    const log = document.getElementById('oi_bf_log');
    if (s.running) {{
      status.textContent = `⏳ в процессе... (записей: ${{s.total_new||0}})`;
    }} else if (s.error) {{
      status.textContent = '⚠ Ошибка: ' + s.error;
    }} else {{
      status.textContent = `✅ готово: +${{s.total_new||0}} новых записей`;
      if (s.log && s.log.length) {{
        log.innerHTML = s.log.map(l => `<div>${{l}}</div>`).join('');
        log.style.display = '';
      }}
    }}
  }} catch(e) {{ if(status) status.textContent = '⚠ ' + e; }}
}}

// ── Диалог консилиума ────────────────────────────────────────────────
async function councilAsk() {{
  const ticker    = document.getElementById('ca_ticker').value.trim().toUpperCase();
  const question  = document.getElementById('ca_question').value.trim();
  const direction = document.getElementById('ca_direction').value;
  const btn       = document.getElementById('ca_btn');
  const statusEl  = document.getElementById('ca_status');
  const resultEl  = document.getElementById('ca_result');
  if (!ticker && !question) {{ statusEl.textContent = '⚠ Укажи тикер или задай вопрос'; return; }}
  btn.disabled = true;
  statusEl.textContent = '⏳ агенты совещаются (~20-35 сек)...';
  resultEl.style.display = 'none';
  try {{
    const data = await fetch('/api/council_ask', {{
      method: 'POST',
      headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{ ticker, question, direction }}),
    }}).then(r => r.json());
    if (!data.ok) {{ statusEl.textContent = '⚠ ' + (data.error || 'ошибка'); btn.disabled=false; return; }}
    const r = data.result || {{}};
    const verdict = r.verdict || 'skip';
    const vBadge = document.getElementById('ca_verdict_badge');
    vBadge.textContent = verdict === 'trade' ? '✓ ТОРГОВАТЬ' : '✗ ПРОПУСТИТЬ';
    vBadge.style.background = verdict === 'trade' ? 'rgba(38,163,123,.25)' : 'rgba(224,82,96,.25)';
    vBadge.style.color = verdict === 'trade' ? 'var(--pos)' : 'var(--neg)';
    document.getElementById('ca_confidence').textContent = r.confidence != null ? `уверенность ${{(r.confidence*100).toFixed(0)}}%` : '';
    document.getElementById('ca_reason').textContent = r.reason || r.summary || '';
    const dialog = r.alpha_thesis || r.alpha || '';
    const skeptic = r.beta_critique || r.beta || '';
    const mod = r.moderator || '';
    document.getElementById('ca_dialog').textContent = [
      dialog ? `Альфа: ${{dialog}}` : '',
      skeptic ? `Бета: ${{skeptic}}` : '',
      mod ? `Модератор: ${{mod}}` : '',
    ].filter(Boolean).join('\\n\\n');
    statusEl.textContent = '';
    resultEl.style.display = '';
  }} catch(e) {{ statusEl.textContent = '⚠ ' + e; }}
  btn.disabled = false;
}}

async function loadLiveScorecard() {{
  try {{
    const data = await fetch('/api/scorecard').then(r=>r.json());
    const el = document.getElementById('live_scorecard');
    const pt = document.getElementById('live_per_ticker');
    if (!data || data.n === 0) {{
      el.innerHTML = '<span style="color:var(--txt3)">Статистики пока нет (trades.jsonl пуст)</span>';
      pt.innerHTML = ''; return;
    }}
    const icons = {{healthy:'✅', ok:'🟡', weak:'🔴', unproven:'⚪'}};
    const icon = icons[data.fitness] || '?';
    const col = {{healthy:'var(--pos)', ok:'#e8b04b', weak:'var(--neg)', unproven:'var(--txt3)'}}[data.fitness] || 'var(--txt2)';
    el.innerHTML =
      `<div style="font-size:14px;font-weight:700;color:${{col}};margin-bottom:6px;">${{icon}} ${{(data.fitness||'').toUpperCase()}} <span style="font-size:11px;font-weight:400;color:var(--txt3);">— ${{data.n}} сделок (окно ${{data.window}})</span></div>` +
      `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">` +
        `<div><div style="color:var(--txt3);font-size:10px;">Win Rate</div><div style="font-weight:700;">${{data.win_rate!=null?(data.win_rate*100).toFixed(0)+'%':'—'}}</div></div>` +
        `<div><div style="color:var(--txt3);font-size:10px;">Profit Factor</div><div style="font-weight:700;">${{data.profit_factor??'—'}}</div></div>` +
        `<div><div style="color:var(--txt3);font-size:10px;">Expectancy</div><div style="font-weight:700;">${{data.expectancy!=null?data.expectancy+'₽':'—'}}</div></div>` +
        `<div><div style="color:var(--txt3);font-size:10px;">Total PnL</div><div style="font-weight:700;color:${{(data.total_pnl||0)>=0?'var(--pos)':'var(--neg)'}}">${{data.total_pnl!=null?(data.total_pnl>=0?'+':'')+data.total_pnl.toFixed(0)+'₽':'—'}}</div></div>` +
        `<div><div style="color:var(--txt3);font-size:10px;">Max Drawdown</div><div style="font-weight:700;color:var(--neg)">${{data.max_drawdown!=null?data.max_drawdown.toFixed(0)+'₽':'—'}}</div></div>` +
        `<div><div style="color:var(--txt3);font-size:10px;">½-Kelly риск</div><div style="font-weight:700;">${{data.kelly_pct!=null?data.kelly_pct.toFixed(2)+'%':'—'}}</div></div>` +
      `</div>` +
      (data.verdict ? `<div style="margin-top:6px;font-size:10px;color:var(--txt3);">${{data.verdict}}</div>` : '');

    if (data.per_ticker && data.per_ticker.length) {{
      pt.innerHTML = '<div style="margin-top:2px;color:var(--txt3);font-size:10px;margin-bottom:4px;">По тикерам:</div>' +
        data.per_ticker.map(r =>
          `<div style="display:flex;gap:8px;padding:2px 0;border-bottom:1px solid var(--border2);">
            <b style="min-width:60px;">${{r.ticker}}</b>
            <span style="color:${{r.total>=0?'var(--pos)':'var(--neg)'}}">${{r.total>=0?'+':''}}${{r.total.toFixed(0)}}₽</span>
            <span style="color:var(--txt3)">${{r.n}} сделок</span>
            <span>WR ${{(r.wr*100).toFixed(0)}}%</span>
          </div>`
        ).join('');
    }} else pt.innerHTML = '';
  }} catch(e) {{
    document.getElementById('live_scorecard').textContent = '⚠ ' + e;
  }}
}}

// ── Управление процессом бота (старт/стоп) ──────────────────────────
async function loadSupervisorStatus() {{
  const data = await fetch('/api/supervisor/status').then(r => r.json()).catch(() => ({{running:false}}));
  const dot = document.getElementById('sup_state_dot');
  const lbl = document.getElementById('sup_state_label');
  const btnStart = document.getElementById('btn_sup_start');
  const btnStop = document.getElementById('btn_sup_stop');
  const btnKill = document.getElementById('btn_sup_kill');
  const modeSel = document.getElementById('sup_mode_sel');
  if (data.running) {{
    const modeTxt = data.sandbox ? '🏖 песочница' : '💸 БОЕВОЙ';
    dot.className = 'sdot ok';
    // Фаза: помогает понять, что бот СЕЙЧАС делает — не «висит», а
    // спит по расписанию МОЕХ. Иконка перед фазой намекает на состояние.
    let phaseTag = '';
    if (data.phase && data.phase_msg) {{
      const icons = {{
        trading: '🟢', waiting_open: '🟡', sleeping_night: '💤',
        starting: '⏳', error: '🔴', unknown: '❔'
      }};
      const ic = icons[data.phase] || '❔';
      let sleep = '';
      if (data.sleep_until_iso) {{
        try {{
          const dt = new Date(data.sleep_until_iso);
          sleep = ` (до ${{dt.toLocaleString('ru-RU', {{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'}})}} MSK)`;
        }} catch(e) {{}}
      }}
      phaseTag = `<br><span style="font-size:10px;color:var(--txt3);">${{ic}} ${{data.phase_msg}}${{sleep}}</span>`;
    }}
    dot.className = 'sdot ok';
    lbl.innerHTML = `▶ Запущен (PID ${{data.pid}}, ${{modeTxt}})${{phaseTag}}`;
    btnStart.style.display = 'none'; modeSel.disabled = true;
    btnStop.style.display = ''; btnKill.style.display = '';
    if (_supStopRequestedAt && Date.now() - _supStopRequestedAt > 8000) {{
      btnKill.style.opacity = '1';
    }}
  }} else {{
    dot.className = 'sdot err';
    lbl.textContent = 'Остановлен';
    btnStart.style.display = ''; modeSel.disabled = false;
    btnStop.style.display = 'none'; btnKill.style.display = 'none';
    _supStopRequestedAt = null;
  }}
}}

async function supervisorStart() {{
  const sandbox = document.getElementById('sup_mode_sel').value === 'sandbox';
  const status = document.getElementById('sup_status');
  if (!sandbox && !confirm('Запустить БОЕВОЙ режим — реальные деньги, реальные ордера. Точно?')) return;
  status.textContent = '⏳ запускаю...';
  const r = await fetch('/api/supervisor/start', {{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{sandbox}})}}).then(r=>r.json());
  status.textContent = r.ok ? `✓ запущен (PID ${{r.pid}})` : ('⚠ ' + (r.error || 'ошибка'));
  await loadSupervisorStatus();
}}

let _supStopRequestedAt = null;
let _supPollAfterStop = null;

async function supervisorStop() {{
  const status = document.getElementById('sup_status');
  status.textContent = '⏳ отправляю запрос на остановку (сработает на ближайшей свече)...';
  const r = await fetch('/api/supervisor/stop', {{method:'POST'}}).then(r=>r.json());
  if (!r.ok && !r.already_stopped) {{ status.textContent = '⚠ ' + (r.error || 'ошибка'); return; }}
  _supStopRequestedAt = Date.now();
  status.textContent = 'Остановка запрошена — жду завершения...';
  if (_supPollAfterStop) clearInterval(_supPollAfterStop);
  _supPollAfterStop = setInterval(async () => {{
    const s = await fetch('/api/supervisor/status').then(r=>r.json());
    if (!s.running) {{
      clearInterval(_supPollAfterStop); _supPollAfterStop = null;
      status.textContent = '✓ остановлен';
      await loadSupervisorStatus();
    }}
  }}, 2000);
  await loadSupervisorStatus();
}}

async function supervisorKill() {{
  if (!confirm('Принудительно завершить процесс? Незавершённые действия бота (например, отправка ордера) могут прерваться на середине.')) return;
  const status = document.getElementById('sup_status');
  status.textContent = '⏳ завершаю принудительно...';
  const r = await fetch('/api/supervisor/force_kill', {{method:'POST'}}).then(r=>r.json());
  status.textContent = r.ok ? '✓ завершён' : '⚠ не удалось завершить';
  if (_supPollAfterStop) {{ clearInterval(_supPollAfterStop); _supPollAfterStop = null; }}
  await loadSupervisorStatus();
}}

async function loadSupervisorLog() {{
  const r = await fetch('/api/supervisor/log?n=200').then(r=>r.json()).catch(() => ({{log:''}}));
  document.getElementById('sup_log').textContent = r.log || '(пусто)';
}}
document.addEventListener('DOMContentLoaded', () => {{
  const det = document.querySelector('#supervisor_panel details');
  if (det) det.addEventListener('toggle', () => {{ if (det.open) loadSupervisorLog(); }});
  // Восстанавливаем вкл/выкл методов сразу при загрузке страницы — иначе
  // верхняя панель чекбоксов стартует пустой (initMethodCheckboxes ленивый,
  // вызывается только при первом открытии панели), и до первого клика по
  // "показать/скрыть" непонятно, что реально выключено сейчас.
  restoreMethodToggleState();
}});

// ── Гибкий выбор тикеров (ticker_universe.py) ───────────────────────
let _uvCatalog = [];
let _uvClassify = {{}};
const UV_TYPE_LABELS = {{stock:'Акции',currency:'Валюта',metal:'Металлы',commodity:'Сырьё',index:'Индексы',foreign:'Иностранные/крипто'}};

function universeModeChanged() {{
  const mode = document.querySelector('input[name=uv_mode]:checked')?.value || 'manual';
  document.getElementById('uv_manual_block').style.display = mode === 'manual' ? '' : 'none';
  document.getElementById('uv_topn_block').style.display = mode === 'top_n' ? '' : 'none';
}}

async function loadUniverse() {{
  const cfg = await fetch('/api/universe').then(r=>r.json()).catch(() => null);
  if (!cfg) return;
  _uvCatalog = cfg.candidates_catalog || [];
  _uvClassify = cfg.classify || {{}};

  document.querySelector(`input[name=uv_mode][value="${{cfg.mode}}"]`).checked = true;
  universeModeChanged();
  document.getElementById('uv_manual_tickers').value = (cfg.manual_tickers || []).join(',');
  document.getElementById('uv_n').value = cfg.top_n?.n || 20;

  const include = new Set(cfg.top_n?.include_types || Object.keys(UV_TYPE_LABELS));
  document.getElementById('uv_types').innerHTML = Object.entries(UV_TYPE_LABELS).map(([type, label]) => `
    <label class="cfg-check"><input type="checkbox" class="uv-type-cb" value="${{type}}" ${{include.has(type) ? 'checked' : ''}}> ${{label}}</label>
  `).join('');

  document.getElementById('uv_resolved_current').textContent = (cfg.resolved_tickers || []).length
    ? cfg.resolved_tickers.join(', ') : '(пусто — используется BASE_TICKERS из settings.ini)';

  if (cfg.last_scores && Object.keys(cfg.last_scores).length) {{
    _uvRenderPreview(cfg.last_scores, cfg.computed_at);
  }}
  if (cfg.computing) {{
    document.getElementById('uv_compute_status').textContent = '⏳ расчёт идёт в фоне...';
    setTimeout(loadUniverse, 3000);
  }}
}}

function _uvSelectedTypes() {{
  return Array.from(document.querySelectorAll('.uv-type-cb:checked')).map(cb => cb.value);
}}

function _uvRenderPreview(scores, computedAt) {{
  const include = new Set(_uvSelectedTypes());
  const n = parseInt(document.getElementById('uv_n').value) || 20;
  const rows = Object.entries(scores)
    .filter(([base, s]) => !s.error && include.has(_uvClassify[base] || 'stock'))
    .sort((a, b) => b[1].score - a[1].score);
  const top = rows.slice(0, n);
  const el = document.getElementById('uv_preview');
  const ts = computedAt ? new Date(computedAt).toLocaleString('ru-RU') : '';
  el.innerHTML = `<div style="color:var(--txt3);margin-bottom:4px;">Посчитано: ${{ts}} · пройдёт фильтр: ${{rows.length}} · возьмём топ-${{n}}:</div>` +
    top.map(([base, s], i) => `
      <div style="display:flex;gap:8px;padding:2px 0;border-bottom:1px solid var(--border2);">
        <span style="color:var(--txt3);width:20px;">${{i+1}}</span>
        <b style="min-width:110px;">${{base}}</b>
        <span style="color:var(--txt3);width:80px;">${{UV_TYPE_LABELS[_uvClassify[base]] || '?'}}</span>
        <span>score ${{s.score}}</span>
        <span style="color:var(--txt3);">об. ${{Math.round(s.avg_volume)}}</span>
        ${{s.alerts ? `<span style="color:var(--accent);">🔔${{s.alerts}}</span>` : ''}}
      </div>
    `).join('');
}}

async function universeCompute() {{
  const status = document.getElementById('uv_compute_status');
  status.textContent = '⏳ считаю по всему каталогу (' + _uvCatalog.length + ' кандидатов, может занять пару минут)...';
  const r = await fetch('/api/universe/compute', {{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{candidates:_uvCatalog}})}}).then(r=>r.json());
  if (!r.ok) {{ status.textContent = '⚠ ' + (r.error || 'ошибка'); return; }}
  status.textContent = '⏳ считаю в фоне...';
  setTimeout(loadUniverse, 3000);
}}

async function universeSave() {{
  const status = document.getElementById('uv_save_status');
  const mode = document.querySelector('input[name=uv_mode]:checked')?.value || 'manual';
  const payload = {{
    mode,
    manual_tickers: document.getElementById('uv_manual_tickers').value.split(',').map(s=>s.trim()).filter(Boolean),
    top_n: {{
      n: parseInt(document.getElementById('uv_n').value) || 20,
      include_types: _uvSelectedTypes(),
      exclude_types: [],
    }},
  }};
  status.textContent = '⏳ сохраняю...';
  const r = await fetch('/api/universe/save', {{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify(payload)}}).then(r=>r.json());
  status.textContent = r.ok ? `✓ сохранено (${{r.resolved_tickers.length}} тикеров) — применится со следующего торгового дня` : ('⚠ ' + (r.error || 'ошибка'));
  await loadUniverse();
}}

async function botPause() {{
  await fetch('/api/bot_control', {{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{action:'pause'}})}});
  await loadBotStatus();
}}

async function botResume() {{
  await fetch('/api/bot_control', {{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{action:'resume'}})}});
  await loadBotStatus();
}}

async function botClose() {{
  const ticker = document.getElementById('close_ticker_sel').value;
  if (!ticker) return;
  const st = document.getElementById('close_status');
  st.textContent = 'Отправляем...';
  const r = await fetch('/api/bot_control', {{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{action:'close',ticker}})}}).then(r=>r.json());
  st.textContent = r.ok ? `✓ Запрос закрытия ${{ticker}} отправлен` : (r.error || 'ошибка');
  await loadBotStatus();
}}

async function botCloseAll() {{
  if (!confirm('Закрыть ВСЕ открытые позиции? Это действие нельзя отменить.')) return;
  const st = document.getElementById('close_status');
  st.textContent = 'Отправляем...';
  const r = await fetch('/api/bot_control', {{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{action:'close',ticker:'ALL'}})}}).then(r=>r.json());
  st.textContent = r.ok ? '✓ Запрос закрытия ALL отправлен' : (r.error || 'ошибка');
  await loadBotStatus();
}}

async function botAdopt() {{
  const ticker = document.getElementById('adopt_ticker').value.trim().toUpperCase();
  const direction = document.getElementById('adopt_dir').value;
  const take = parseFloat(document.getElementById('adopt_take').value);
  const stop = parseFloat(document.getElementById('adopt_stop').value);
  const entryRaw = document.getElementById('adopt_entry').value.trim();
  const entry = entryRaw ? parseFloat(entryRaw) : null;
  const st = document.getElementById('adopt_status');
  if (!ticker || isNaN(take) || isNaN(stop)) {{
    st.textContent = '⚠ Укажи тикер, тейк и стоп'; return;
  }}
  if (direction === 'LONG' && take <= stop) {{
    st.textContent = '⚠ LONG: тейк должен быть выше стопа'; return;
  }}
  if (direction === 'SHORT' && take >= stop) {{
    st.textContent = '⚠ SHORT: тейк должен быть ниже стопа'; return;
  }}
  if (entry !== null) {{
    if (direction === 'LONG' && (entry <= stop || entry >= take)) {{
      st.textContent = '⚠ LONG: вход должен быть между стопом и тейком'; return;
    }}
    if (direction === 'SHORT' && (entry >= stop || entry <= take)) {{
      st.textContent = '⚠ SHORT: вход должен быть между тейком и стопом'; return;
    }}
  }}
  st.textContent = 'Отправляем...';
  const body = {{ticker, direction, take, stop}};
  if (entry !== null) body.entry = entry;
  const r = await fetch('/api/bot_adopt', {{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify(body)}}).then(r=>r.json());
  st.textContent = r.ok
    ? `✓ ${{ticker}} ${{direction}} — передано боту. Тейк ${{take}}, Стоп ${{stop}}. Сработает на следующей свече.`
    : (r.error || 'ошибка');
}}

async function botMoveStop() {{
  const ticker = document.getElementById('ms_ticker').value.trim().toUpperCase();
  const newStop = parseFloat(document.getElementById('ms_stop').value);
  const newTakeRaw = document.getElementById('ms_take').value.trim();
  const newTake = newTakeRaw ? parseFloat(newTakeRaw) : null;
  const st = document.getElementById('ms_status');
  if (!ticker || isNaN(newStop)) {{
    st.textContent = '⚠ Укажи тикер и новый стоп'; return;
  }}
  st.textContent = 'Отправляем...';
  const body = {{ticker, new_stop: newStop}};
  if (newTake !== null) body.new_take = newTake;
  const r = await fetch('/api/bot_move_stop', {{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify(body)}}).then(r=>r.json());
  st.textContent = r.ok
    ? `✓ ${{ticker}}: стоп → ${{newStop}}${{newTake !== null ? ', тейк → ' + newTake : ''}}. Сработает на следующей свече.`
    : (r.error || 'ошибка');
}}

async function loadOverrides() {{
  const resp = await fetch('/api/overrides');
  const data = await resp.json();
  document.getElementById('ov_global_mode').value =
    data.global_signal_only === true ? 'sandbox' : (data.global_signal_only === false ? 'live' : 'auto');
  document.getElementById('ov_partial_tp').checked = data.partial_tp_enabled === true;
  document.getElementById('ov_adaptive_exit').checked = data.adaptive_exit_enabled === true;
  document.getElementById('ov_orderbook').checked = data.orderbook_enabled === true;
  document.getElementById('ov_daily_loss').value = data.daily_max_loss_pct ?? '';
  document.getElementById('ov_weekly_loss').value = data.weekly_max_loss_pct ?? '';
  document.getElementById('ov_monthly_loss').value = data.monthly_max_loss_pct ?? '';
  const tbody = document.getElementById('ov_table');
  const oiImportOnly = data.oi_import_only || {{}};
  tbody.innerHTML = data.tickers_all.map(t => ovRowHtml(t, data.tickers[t], oiImportOnly[t])).join('');
  document.getElementById('ov_status').textContent = 'загружено';
}}

async function saveOverrides() {{
  const globalMode = document.getElementById('ov_global_mode').value;
  const global_signal_only = globalMode === 'sandbox' ? true : (globalMode === 'live' ? false : null);
  const partial_tp_enabled = document.getElementById('ov_partial_tp').checked;
  const adaptive_exit_enabled = document.getElementById('ov_adaptive_exit').checked;
  const orderbook_enabled = document.getElementById('ov_orderbook').checked;
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
      global_signal_only, partial_tp_enabled, adaptive_exit_enabled, orderbook_enabled, tickers,
      daily_max_loss_pct: document.getElementById('ov_daily_loss').value || null,
      weekly_max_loss_pct: document.getElementById('ov_weekly_loss').value || null,
      monthly_max_loss_pct: document.getElementById('ov_monthly_loss').value || null,
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

async function loadDiagnostics() {{
  const ticker = document.getElementById('diag_ticker').value.trim().toUpperCase();
  const days = document.getElementById('diag_days').value;
  const summary = document.getElementById('diag_summary');
  const table = document.getElementById('diag_table');
  if (!ticker) {{ summary.textContent = 'Укажи тикер.'; return; }}
  summary.textContent = 'Считаю...';
  table.innerHTML = '';
  const resp = await fetch(`/api/diagnostics?ticker=${{ticker}}&days=${{days}}`);
  const data = await resp.json();
  if (!data.ready) {{
    summary.textContent = data.error || 'Недостаточно данных.';
    return;
  }}
  const regimeProbs = Object.entries(data.regime_probs || {{}})
    .sort((a, b) => b[1] - a[1])
    .map(([r, p]) => `${{r}}: ${{(p * 100).toFixed(0)}}%`).join(', ');
  summary.innerHTML = `Текущий режим (argmax): <b>${{data.regime}}</b> · смесь: ${{regimeProbs}}<br>` +
    `rolling_quality: ${{data.rolling_quality}} · M1/M2/M3 готовы: ${{data.cluster_models_ready ? 'да' : 'нет (мало истории)'}}` +
    (data.cluster_corr_regimes && data.cluster_corr_regimes.length
      ? ` · RMT-корреляция накоплена для режимов: ${{data.cluster_corr_regimes.join(', ')}}`
      : ' · RMT-корреляция по режимам пока нигде не накоплена (fallback на общую матрицу)');
  table.innerHTML = `<thead><tr>
      <th>Метод</th><th>Hedge-вес</th><th>сделок</th><th>regime_mult</th>
      <th>redundancy_mult</th><th>эфф. вес</th><th>микростр.</th>
    </tr></thead>` + (data.methods || []).map(m => `<tr>
      <td>${{m.name}}</td><td>${{m.hedge_weight}}</td><td>${{m.hedge_trades}}</td>
      <td>${{m.regime_mult}}</td><td>${{m.redundancy_mult}}</td>
      <td><b>${{m.effective_weight}}</b></td><td>${{m.is_microstructure ? '✓' : ''}}</td>
    </tr>`).join('');
}}

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

// ── График сделок ────────────────────────────────────────────────────────────
(function() {{
  let _candles = [], _trades = [], _ticker = '';
  const PAD = {{l:52, r:12, t:24, b:36}};
  let _v0 = 0, _v1 = 0;
  let _drag = null;
  let _chartMode = 'candle';  // 'candle' | 'line'
  // Выделение области: {i0, i1} — индексы баров, null если нет
  let _sel = null;
  let _selDrag = null;  // {startI, startX} во время Shift+drag
  const canvas = document.getElementById('tc_canvas');
  const ctx = canvas.getContext('2d');

  function _dpr() {{ return window.devicePixelRatio || 1; }}

  function _resize() {{
    const dpr = _dpr();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    _draw();
  }}

  function _cw() {{ return canvas.clientWidth; }}
  function _ch() {{ return canvas.clientHeight; }}
  function _innerW() {{ return _cw() - PAD.l - PAD.r; }}
  function _innerH() {{ return _ch() - PAD.t - PAD.b; }}

  // Масштаб: px на свечу
  function _barW() {{ return Math.max(1, _innerW() / Math.max(1, _v1 - _v0 + 1)); }}

  function _xOfBar(i) {{
    return PAD.l + (i - _v0 + 0.5) * _barW();
  }}

  function _priceRange() {{
    const slice = _candles.slice(_v0, _v1 + 1);
    if (!slice.length) return {{lo: 0, hi: 1}};
    let lo = Infinity, hi = -Infinity;
    for (const c of slice) {{
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    }}
    // расширить на take/stop сделок в видимом диапазоне
    for (const t of _trades) {{
      if (t._entry_i >= _v0 && t._entry_i <= _v1) {{
        if (t.take_price && t.take_price < lo) lo = t.take_price;
        if (t.take_price && t.take_price > hi) hi = t.take_price;
        if (t.stop_price && t.stop_price < lo) lo = t.stop_price;
        if (t.stop_price && t.stop_price > hi) hi = t.stop_price;
      }}
    }}
    const margin = (hi - lo) * 0.08 || hi * 0.01;
    return {{lo: lo - margin, hi: hi + margin}};
  }}

  function _yOf(price, lo, hi) {{
    const h = _innerH();
    return PAD.t + h - (price - lo) / (hi - lo) * h;
  }}

  function _fmtTime(iso) {{
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('ru-RU', {{day:'2-digit', month:'2-digit'}}) + ' ' +
           d.toLocaleTimeString('ru-RU', {{hour:'2-digit', minute:'2-digit'}});
  }}

  function _draw() {{
    if (!_candles.length) return;
    const W = _cw(), H = _ch();
    const iW = _innerW(), iH = _innerH();
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--panel').trim() || '#1a1a2e';
    ctx.fillRect(0, 0, W, H);

    const {{lo, hi}} = _priceRange();
    const bw = _barW();

    // ── сетка ────────────────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    const nGridY = 5;
    for (let g = 0; g <= nGridY; g++) {{
      const price = lo + (hi - lo) * (g / nGridY);
      const y = _yOf(price, lo, hi);
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + iW, y); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(price.toFixed(2), PAD.l - 3, y + 3);
    }}

    // ── подсветка выделенной области ─────────────────────────────────────
    if (_sel) {{
      const si0 = Math.max(_v0, _sel.i0), si1 = Math.min(_v1, _sel.i1);
      if (si0 <= si1) {{
        const sx0 = _xOfBar(si0) - bw / 2, sx1 = _xOfBar(si1) + bw / 2;
        ctx.fillStyle = 'rgba(120,180,255,0.10)';
        ctx.fillRect(sx0, PAD.t, sx1 - sx0, iH);
        // вертикальные границы
        ctx.strokeStyle = 'rgba(120,180,255,0.5)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4,3]);
        ctx.beginPath(); ctx.moveTo(sx0, PAD.t); ctx.lineTo(sx0, PAD.t + iH); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(sx1, PAD.t); ctx.lineTo(sx1, PAD.t + iH); ctx.stroke();
        ctx.setLineDash([]);
      }}
    }}

    // ── уровни сделок (take/stop) ─────────────────────────────────────────
    for (const t of _trades) {{
      if (t._entry_i < _v0 || t._entry_i > _v1) continue;
      const xi = t._exit_i !== null ? Math.min(t._exit_i, _v1) : _v1;
      const x0 = _xOfBar(t._entry_i), x1 = _xOfBar(xi);
      ctx.lineWidth = 1;
      if (t.take_price) {{
        ctx.strokeStyle = 'rgba(72,199,142,0.3)'; ctx.setLineDash([3,4]);
        ctx.beginPath(); ctx.moveTo(x0, _yOf(t.take_price, lo, hi)); ctx.lineTo(x1, _yOf(t.take_price, lo, hi)); ctx.stroke();
      }}
      if (t.stop_price) {{
        ctx.strokeStyle = 'rgba(255,99,99,0.3)'; ctx.setLineDash([3,4]);
        ctx.beginPath(); ctx.moveTo(x0, _yOf(t.stop_price, lo, hi)); ctx.lineTo(x1, _yOf(t.stop_price, lo, hi)); ctx.stroke();
      }}
      ctx.setLineDash([]);
    }}

    // ── свечи или линия ───────────────────────────────────────────────────
    if (_chartMode === 'line') {{
      // заливка под линией
      ctx.beginPath();
      let first = true;
      for (let i = _v0; i <= _v1 && i < _candles.length; i++) {{
        const x = _xOfBar(i), y = _yOf(_candles[i].close, lo, hi);
        if (first) {{ ctx.moveTo(x, y); first = false; }} else ctx.lineTo(x, y);
      }}
      const lastX = _xOfBar(Math.min(_v1, _candles.length - 1));
      ctx.lineTo(lastX, PAD.t + iH); ctx.lineTo(_xOfBar(_v0), PAD.t + iH); ctx.closePath();
      const grad = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + iH);
      grad.addColorStop(0, 'rgba(100,160,255,0.25)'); grad.addColorStop(1, 'rgba(100,160,255,0.0)');
      ctx.fillStyle = grad; ctx.fill();
      // сама линия
      ctx.beginPath(); first = true;
      for (let i = _v0; i <= _v1 && i < _candles.length; i++) {{
        const x = _xOfBar(i), y = _yOf(_candles[i].close, lo, hi);
        if (first) {{ ctx.moveTo(x, y); first = false; }} else ctx.lineTo(x, y);
      }}
      ctx.strokeStyle = '#6ba3ff'; ctx.lineWidth = 1.5; ctx.stroke();
    }} else {{
      const bodyW = Math.max(1, bw * 0.6), halfBody = bodyW / 2;
      for (let i = _v0; i <= _v1 && i < _candles.length; i++) {{
        const c = _candles[i], x = _xOfBar(i);
        const yO = _yOf(c.open, lo, hi), yC = _yOf(c.close, lo, hi);
        const yH = _yOf(c.high, lo, hi), yL = _yOf(c.low, lo, hi);
        const bull = c.close >= c.open;
        ctx.strokeStyle = bull ? '#48c78e' : '#f14668'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke();
        ctx.fillStyle = bull ? 'rgba(72,199,142,0.85)' : 'rgba(241,70,104,0.85)';
        ctx.fillRect(x - halfBody, Math.min(yO, yC), bodyW, Math.max(1, Math.abs(yC - yO)));
      }}
    }}

    // ── маркеры сделок ───────────────────────────────────────────────────
    for (let ti = 0; ti < _trades.length; ti++) {{
      const t = _trades[ti];
      if (t._entry_i < _v0 || t._entry_i > _v1) continue;
      const xe = _xOfBar(t._entry_i), ye = _yOf(t.entry_price, lo, hi);
      const isLong = t.direction === 'LONG', winCol = t.win ? '#48c78e' : '#f14668';
      if (t._exit_i !== null && t._exit_i >= _v0) {{
        const xx = _xOfBar(Math.min(t._exit_i, _v1)), yx = _yOf(t.exit_price, lo, hi);
        ctx.strokeStyle = winCol + '66'; ctx.lineWidth = 1.5; ctx.setLineDash([2,3]);
        ctx.beginPath(); ctx.moveTo(xe, ye); ctx.lineTo(xx, yx); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(xx, yx, 4, 0, Math.PI * 2); ctx.fillStyle = winCol; ctx.fill();
      }}
      ctx.fillStyle = isLong ? '#48c78e' : '#f14668';
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.8;
      ctx.beginPath();
      if (isLong) {{ ctx.moveTo(xe, ye-10); ctx.lineTo(xe-6, ye); ctx.lineTo(xe+6, ye); }}
      else        {{ ctx.moveTo(xe, ye+10); ctx.lineTo(xe-6, ye); ctx.lineTo(xe+6, ye); }}
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 8px JetBrains Mono,monospace'; ctx.textAlign = 'center';
      ctx.fillText(ti + 1, xe, isLong ? ye - 12 : ye + 20);
    }}

    // ── временна́я ось ────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'center';
    const nLabels = Math.min(8, _v1 - _v0 + 1);
    const step = Math.max(1, Math.floor((_v1 - _v0 + 1) / nLabels));
    for (let i = _v0; i <= _v1; i += step) {{
      const iso = _candles[i]?.time; if (!iso) continue;
      const d = new Date(iso);
      ctx.fillText(d.toLocaleDateString('ru-RU', {{day:'2-digit',month:'2-digit'}}), _xOfBar(i), _ch() - 6);
    }}

    // ── заголовок ────────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = 'bold 12px JetBrains Mono,monospace'; ctx.textAlign = 'left';
    ctx.fillText(_ticker, PAD.l + 4, PAD.t - 6);
  }}

  // ── Поиск ближайшей сделки по пиксельной биссектрисе ────────────────────
  function _hitTrade(px, py) {{
    const {{lo, hi}} = _priceRange();
    let best = null, bestD = 20;
    for (let ti = 0; ti < _trades.length; ti++) {{
      const t = _trades[ti];
      if (t._entry_i < _v0 || t._entry_i > _v1 || !t.entry_price) continue;
      const x = _xOfBar(t._entry_i);
      const y = _yOf(t.entry_price, lo, hi);
      const d = Math.hypot(px - x, py - y);
      if (d < bestD) {{ bestD = d; best = ti; }}
    }}
    return best;
  }}

  // Преобразовать пиксель X → индекс бара
  function _barAtX(px) {{
    return Math.round(_v0 + (px - PAD.l) / _barW() - 0.5);
  }}

  // Обновить инфо-блок выделения
  function _updateSelInfo() {{
    const el = document.getElementById('tc_sel_info');
    if (!_sel || !_candles.length) {{ el.style.display = 'none'; return; }}
    const i0 = Math.max(0, Math.min(_sel.i0, _sel.i1));
    const i1 = Math.min(_candles.length - 1, Math.max(_sel.i0, _sel.i1));
    if (i0 >= i1) {{ el.style.display = 'none'; return; }}
    const p0 = _candles[i0].close, p1 = _candles[i1].close;
    const diff = p1 - p0, pct = (diff / p0 * 100);
    const hi = Math.max(..._candles.slice(i0, i1+1).map(c => c.high));
    const lo = Math.min(..._candles.slice(i0, i1+1).map(c => c.low));
    const swing = (hi - lo) / p0 * 100;
    const nBars = i1 - i0 + 1;
    const col = diff >= 0 ? '#48c78e' : '#f14668';
    const sign = diff >= 0 ? '+' : '';
    // Сделки внутри выделения
    const tradesIn = _trades.filter(t => t._entry_i >= i0 && t._entry_i <= i1);
    const wins = tradesIn.filter(t => t.win).length;
    const tradeStr = tradesIn.length ? ` &nbsp;|&nbsp; Сделок в области: ${{tradesIn.length}} (W=${{wins}}/L=${{tradesIn.length - wins}})` : '';
    el.style.display = 'block';
    el.innerHTML =
      `📐 Выделено ${{nBars}} баров &nbsp;|&nbsp; `+
      `Начало: ${{p0.toFixed(2)}} → Конец: ${{p1.toFixed(2)}} &nbsp;|&nbsp; `+
      `Изменение: <b style="color:${{col}}">${{sign}}${{diff.toFixed(2)}} (${{sign}}${{pct.toFixed(2)}}%)</b> &nbsp;|&nbsp; `+
      `Амплитуда Hi–Lo: ${{swing.toFixed(2)}}%`+
      tradeStr+
      ` &nbsp;<span style="color:var(--txt3);cursor:pointer;" onclick="tcClearSel()">✕ сброс</span>`;
  }}

  window.tcClearSel = function() {{ _sel = null; _updateSelInfo(); _draw(); }};

  // ── Тултип при движении мыши ─────────────────────────────────────────────
  canvas.addEventListener('mousemove', function(e) {{
    // Shift+drag: обновляем правую границу выделения
    if (_selDrag) {{
      const rect = canvas.getBoundingClientRect();
      const bi = Math.max(0, Math.min(_candles.length-1, _barAtX(e.clientX - rect.left)));
      _sel = {{i0: Math.min(_selDrag.startI, bi), i1: Math.max(_selDrag.startI, bi)}};
      _updateSelInfo();
      _draw();
      return;
    }}
    if (_drag) {{
      const dx = e.clientX - _drag.startX;
      const barsShift = -Math.round(dx / _barW());
      let v0 = _drag.v0 + barsShift, v1 = _drag.v1 + barsShift;
      const span = v1 - v0;
      if (v0 < 0) {{ v0 = 0; v1 = span; }}
      if (v1 >= _candles.length) {{ v1 = _candles.length - 1; v0 = v1 - span; }}
      _v0 = Math.max(0, v0); _v1 = Math.min(_candles.length - 1, v1);
      _draw();
      return;
    }}
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const ti = _hitTrade(px, py);
    const tip = document.getElementById('tc_tooltip');
    if (ti !== null) {{
      const t = _trades[ti];
      tip.style.display = 'block';
      const dir = t.direction === 'LONG' ? '📈 LONG' : '📉 SHORT';
      const res = t.win ? '✅ профит' : '❌ убыток';
      tip.innerHTML = `<b>#${{ti+1}} ${{dir}}</b> &nbsp; ${{res}} &nbsp; net: ${{t.net_pct >= 0 ? '+' : ''}}${{t.net_pct}}% &nbsp; R=${{t.r_multiple}} &nbsp; ${{Math.round(t.duration_min)}}мин`;
    }} else {{
      tip.style.display = 'none';
    }}
  }});

  canvas.addEventListener('mousedown', function(e) {{
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;

    // Shift+drag → выделение области
    if (e.shiftKey) {{
      const bi = Math.max(0, Math.min(_candles.length-1, _barAtX(px)));
      _selDrag = {{startI: bi}};
      _sel = {{i0: bi, i1: bi}};
      _draw();
      return;
    }}

    const ti = _hitTrade(px, py);
    if (ti !== null) {{ _showTradeDetail(ti); return; }}
    _drag = {{startX: e.clientX, v0: _v0, v1: _v1}};
  }});
  canvas.addEventListener('mouseup', function(e) {{
    if (_selDrag) {{ _selDrag = null; _updateSelInfo(); return; }}
    _drag = null;
  }});
  canvas.addEventListener('mouseleave', () => {{ _drag = null; _selDrag = null; }});

  canvas.addEventListener('wheel', function(e) {{
    e.preventDefault();
    const ratio = e.deltaY < 0 ? 0.85 : 1.18;
    const span = _v1 - _v0 + 1;
    const newSpan = Math.max(10, Math.min(_candles.length, Math.round(span * ratio)));
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const center = _v0 + (px - PAD.l) / _innerW() * span;
    let v0 = Math.round(center - newSpan * (px - PAD.l) / _innerW());
    let v1 = v0 + newSpan - 1;
    if (v0 < 0) {{ v0 = 0; v1 = newSpan - 1; }}
    if (v1 >= _candles.length) {{ v1 = _candles.length - 1; v0 = v1 - newSpan + 1; }}
    _v0 = Math.max(0, v0); _v1 = Math.min(_candles.length - 1, v1);
    _draw();
  }}, {{passive: false}});

  // Тач (пинч + панорама на мобиле)
  let _touch = null;
  canvas.addEventListener('touchstart', e => {{
    if (e.touches.length === 1) _touch = {{x: e.touches[0].clientX, v0: _v0, v1: _v1, pinch: null}};
    if (e.touches.length === 2) {{
      const d = Math.abs(e.touches[0].clientX - e.touches[1].clientX);
      _touch = {{x: 0, v0: _v0, v1: _v1, pinch: d}};
    }}
  }}, {{passive: true}});
  canvas.addEventListener('touchmove', e => {{
    e.preventDefault();
    if (!_touch) return;
    if (e.touches.length === 1 && _touch.pinch === null) {{
      const dx = e.touches[0].clientX - _touch.x;
      const barsShift = -Math.round(dx / _barW());
      let v0 = _touch.v0 + barsShift, v1 = _touch.v1 + barsShift;
      const span = v1 - v0;
      if (v0 < 0) {{ v0 = 0; v1 = span; }}
      if (v1 >= _candles.length) {{ v1 = _candles.length - 1; v0 = v1 - span; }}
      _v0 = Math.max(0, v0); _v1 = Math.min(_candles.length - 1, v1);
      _draw();
    }}
    if (e.touches.length === 2 && _touch.pinch !== null) {{
      const d = Math.abs(e.touches[0].clientX - e.touches[1].clientX);
      const ratio = _touch.pinch / Math.max(1, d);
      const span = _touch.v1 - _touch.v0 + 1;
      const newSpan = Math.max(10, Math.min(_candles.length, Math.round(span * ratio)));
      let v0 = _touch.v0, v1 = v0 + newSpan - 1;
      if (v1 >= _candles.length) {{ v1 = _candles.length - 1; v0 = v1 - newSpan + 1; }}
      _v0 = Math.max(0, v0); _v1 = Math.min(_candles.length - 1, v1);
      _draw();
    }}
  }}, {{passive: false}});
  canvas.addEventListener('touchend', () => _touch = null);

  function _showTradeDetail(ti) {{
    const t = _trades[ti];
    const dir = t.direction === 'LONG' ? '📈 LONG' : '📉 SHORT';
    const res = t.win ? '✅' : '❌';
    const mfeP = t.mfe !== null ? (t.mfe * 100).toFixed(2) : '—';
    const maeP = t.mae !== null ? (t.mae * 100).toFixed(2) : '—';
    document.getElementById('tc_trade_detail').innerHTML =
      `<b>#${{ti+1}} ${{dir}} ${{res}}</b> &nbsp;&nbsp;`+
      `Вход: ${{t.entry_price}} (${{_fmtTime(t.entry_time)}}) &rarr; `+
      `Выход: ${{t.exit_price}} (${{_fmtTime(t.exit_time)}}) &nbsp;&nbsp;`+
      `net: <b style="color:${{t.win?'#48c78e':'#f14668'}}">${{t.net_pct >= 0?'+':''}}${{t.net_pct}}%</b> &nbsp;&nbsp;`+
      `R=${{t.r_multiple}} &nbsp;&nbsp;`+
      `Тейк: ${{t.take_price || '—'}} &nbsp;`+
      `Стоп: ${{t.stop_price || '—'}} &nbsp;&nbsp;`+
      `MFE: +${{mfeP}}% &nbsp; MAE: -${{maeP}}% &nbsp;&nbsp;`+
      `${{Math.round(t.duration_min)}} мин`;
  }}

  // ── Зум ─────────────────────────────────────────────────────────────────
  window.tcSetMode = function(mode) {{
    _chartMode = mode;
    document.getElementById('tc_mode_candle').classList.toggle('toggled', mode === 'candle');
    document.getElementById('tc_mode_candle').classList.toggle('ghost', mode !== 'candle');
    document.getElementById('tc_mode_line').classList.toggle('toggled', mode === 'line');
    document.getElementById('tc_mode_line').classList.toggle('ghost', mode !== 'line');
    _draw();
  }};

  window.tcZoomAll = function() {{
    if (!_candles.length) return;
    _v0 = 0; _v1 = _candles.length - 1; _draw();
  }};
  window.tcZoomLast = function(days) {{
    if (!_candles.length) return;
    // Примерно 10 свечей в день (1-минутные), подбираем по дате
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    let i = 0;
    for (; i < _candles.length; i++) {{
      if (_candles[i].time >= cutoff) break;
    }}
    _v0 = Math.max(0, i); _v1 = _candles.length - 1;
    _draw();
  }};

  // Кэш: cacheKey → {candles, trades} — не перезапрашиваем одно и то же
  const _tcCache = {{}};

  function _cacheKey(ticker, days, take, stop) {{
    return `${{ticker}}::${{days}}::${{take}}::${{stop}}`;
  }}

  function _indexTrades(candles, trades) {{
    const timeIdx = {{}};
    candles.forEach((c, i) => {{ timeIdx[c.time] = i; }});
    return trades.map(t => {{
      const _findIdx = (iso) => {{
        if (!iso) return null;
        let idx = timeIdx[iso];
        if (idx !== undefined) return idx;
        const ms = new Date(iso).getTime();
        let best = null, bestD = Infinity;
        candles.forEach((c, i) => {{
          const d = Math.abs(new Date(c.time).getTime() - ms);
          if (d < bestD) {{ bestD = d; best = i; }}
        }});
        return best;
      }};
      return {{...t, _entry_i: _findIdx(t.entry_time), _exit_i: _findIdx(t.exit_time)}};
    }});
  }}

  function _applyData(data) {{
    _candles = data.candles;
    _ticker = data.ticker;
    _trades = _indexTrades(data.candles, data.trades || []);
    _v0 = 0; _v1 = _candles.length - 1;
    _resize();
    document.getElementById('tc_status').textContent =
      `${{_candles.length}} свечей, ${{_trades.length}} сделок (из кэша)`;
  }}

  // Заполнить select тикерами из бэктеста; вызывается из runBacktest
  window.tcPopulateTickers = function(tickers, days, atrTake, atrStop) {{
    const sel = document.getElementById('tc_ticker');
    sel.innerHTML = tickers.map(t => `<option value="${{t}}">${{t}}</option>`).join('');
    document.getElementById('tc_take').value = atrTake;
    document.getElementById('tc_stop').value = atrStop;
    window._tcDays = days;
    if (tickers.length > 0) loadTradeChart();
  }};

  // ── Загрузка данных (с кэшем) ────────────────────────────────────────────
  window.loadTradeChart = async function() {{
    const ticker = document.getElementById('tc_ticker').value;
    const days = window._tcDays || document.getElementById('days')?.value || 90;
    const take = document.getElementById('tc_take').value;
    const stop = document.getElementById('tc_stop').value;
    if (!ticker) {{ alert('Сначала запусти бэктест'); return; }}

    const key = _cacheKey(ticker, days, take, stop);
    if (_tcCache[key]) {{
      _applyData(_tcCache[key]);
      document.getElementById('tc_trade_detail').innerHTML = '';
      document.getElementById('tc_tooltip').style.display = 'none';
      return;
    }}

    document.getElementById('tc_status').textContent = 'загрузка...';
    document.getElementById('tc_trade_detail').innerHTML = '';
    document.getElementById('tc_tooltip').style.display = 'none';
    try {{
      const resp = await fetch(`/api/trade_chart?ticker=${{encodeURIComponent(ticker)}}&days=${{days}}&atr_take=${{take}}&atr_stop=${{stop}}`);
      const data = await resp.json();
      if (data.error) {{
        document.getElementById('tc_status').textContent = '❌ ' + data.error;
        return;
      }}
      _tcCache[key] = data;
      _candles = data.candles;
      _ticker = data.ticker;
      _trades = _indexTrades(data.candles, data.trades || []);
      _v0 = 0; _v1 = _candles.length - 1;
      _resize();
      document.getElementById('tc_status').textContent =
        `${{_candles.length}} свечей, ${{_trades.length}} сделок`;
    }} catch(e) {{
      document.getElementById('tc_status').textContent = '❌ ' + e;
    }}
  }};

  window.addEventListener('resize', _resize);
  _resize();
}})();

async function exportBarScores() {{
  const ticker = document.getElementById('tc_ticker').value;
  if (!ticker) {{ alert('Сначала выбери тикер'); return; }}
  const days = 90;
  const status = document.getElementById('tc_status');
  status.textContent = 'подготовка CSV...';
  try {{
    const resp = await fetch(`/api/export_bar_scores?ticker=${{encodeURIComponent(ticker)}}&days=${{days}}`);
    if (!resp.ok) {{
      const j = await resp.json().catch(() => ({{}}));
      status.textContent = '❌ ' + (j.error || resp.statusText);
      return;
    }}
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${{ticker}}_bar_scores_${{days}}d.csv`;
    a.click();
    URL.revokeObjectURL(url);
    status.textContent = 'CSV скачан ✓';
  }} catch(e) {{
    status.textContent = '❌ ' + e;
  }}
}}

// ══════════════════════ АНАЛИТИКА ══════════════════════

let _anData = null;

async function runEquityAnalysis() {{
  const tickers = Array.from(document.querySelectorAll('.chip.active')).map(c => c.dataset.ticker).filter(Boolean);
  if (!tickers.length) {{ alert('Выбери хотя бы один тикер в «Симуляция»'); return; }}
  const days = parseInt(document.getElementById('an_days').value) || 60;
  const account = parseFloat(document.getElementById('an_account').value) || 100000;
  const risk_pct = parseFloat(document.getElementById('an_risk').value) || 1;
  const status = document.getElementById('an_status');
  status.textContent = '⏳ считаем...';
  document.getElementById('an_summary_panel').style.display = 'none';
  document.getElementById('an_charts_panel').style.display = 'none';
  document.getElementById('an_model_panel').style.display = 'none';
  try {{
    const resp = await fetch('/api/equity_analysis', {{
      method: 'POST',
      headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{tickers, days, account, risk_pct}}),
    }});
    const data = await resp.json();
    if (data.error) {{ status.textContent = '❌ ' + data.error; return; }}
    _anData = data;
    status.textContent = `✓ ${{data.summary?.n_trades ?? 0}} сделок`;
    _renderAnalytics(data, account);
  }} catch(e) {{
    status.textContent = '❌ ' + e;
  }}
}}

function _renderAnalytics(data, account) {{
  const an = data.analytics || {{}};
  const summary = data.summary || {{}};

  // Сводка
  document.getElementById('an_summary_panel').style.display = '';
  const pnl = summary.pnl_rub || 0;
  const pnlPct = account ? ((pnl / account) * 100).toFixed(1) : '—';
  const nTrades = summary.n_trades || 0;
  const winRate = nTrades ? (((data.trades || []).filter(t => t.net_pct > 0).length / nTrades) * 100).toFixed(1) : '—';
  const dd = summary.max_drawdown_rub || 0;
  document.getElementById('an_summary').innerHTML =
    `<b style="color:${{pnl >= 0 ? 'var(--pos)' : 'var(--neg)'}}">${{pnl >= 0 ? '+' : ''}}${{pnl.toFixed(0)}} ₽ (${{pnlPct}}%)</b> &nbsp;·&nbsp; ` +
    `${{nTrades}} сделок &nbsp;·&nbsp; WR ${{winRate}}% &nbsp;·&nbsp; ` +
    `MaxDD ${{dd.toFixed(0)}} ₽ &nbsp;·&nbsp; Счёт → <b>${{(summary.equity_end || account).toFixed(0)}} ₽</b>`;

  // Charts
  document.getElementById('an_charts_panel').style.display = '';
  _drawLineChart('an_eq_canvas', an.daily_equity || [], 'date', 'equity', account,
    '#A78BFA', true, 'Equity ₽');
  _drawLineChart('an_wr_canvas', an.rolling_winrate || [], 'trade_n', 'win_rate', 0.5,
    '#52F2C9', false, 'Rolling WR (20 сд)', [0, 1], 0.5);
  _drawLearningCurve('an_lc_canvas', an.learning_curve || []);

  // Weekly table
  const tbody = document.querySelector('#an_weekly_table tbody');
  tbody.innerHTML = '';
  for (const w of (an.weekly_stats || [])) {{
    const pnlColor = w.pnl_rub >= 0 ? 'var(--pos)' : 'var(--neg)';
    tbody.innerHTML += `<tr><td>${{w.week}}</td><td>${{w.n}}</td>` +
      `<td>${{(w.win_rate * 100).toFixed(0)}}%</td>` +
      `<td style="color:${{pnlColor}}">${{w.pnl_rub >= 0 ? '+' : ''}}${{w.pnl_rub.toFixed(0)}}</td></tr>`;
  }}

  // Model table
  const ms = data.model_stats || {{}};
  const tbody2 = document.getElementById('an_model_tbody');
  tbody2.innerHTML = '';
  let hasModel = false;
  for (const name of ['M1_CLUSTER', 'M2_CLUSTER', 'M3_CLUSTER']) {{
    const s = ms[name];
    if (!s) continue;
    hasModel = true;
    const agreeWR = s.agree_win_rate !== null ? (s.agree_win_rate * 100).toFixed(0) + '%' : '—';
    const disWR = s.disagree_win_rate !== null ? (s.disagree_win_rate * 100).toFixed(0) + '%' : '—';
    const disColor = s.disagree_n > 0 && s.disagree_win_rate !== null && s.disagree_win_rate < (s.agree_win_rate || 0.5)
      ? 'color:var(--pos)' : 'color:var(--neg)';
    tbody2.innerHTML += `<tr><td>${{name.replace('_CLUSTER', '')}}</td>` +
      `<td>${{s.agree_n}}</td><td>${{agreeWR}}</td>` +
      `<td style="${{disColor}}">${{s.disagree_n}}</td><td style="${{disColor}}">${{disWR}}</td></tr>`;
  }}
  document.getElementById('an_model_panel').style.display = hasModel ? '' : 'none';

  // Methods table
  const mst = an.method_stats || {{}};
  const methodKeys = Object.keys(mst);
  document.getElementById('an_methods_panel').style.display = methodKeys.length ? '' : 'none';
  if (methodKeys.length) _renderMethodsTable(mst, 'agree_n');
}}

let _anMethodStats = {{}};
function _renderMethodsTable(mst, sortKey) {{
  _anMethodStats = mst;
  const tbody = document.getElementById('an_methods_tbody');
  const rows = Object.entries(mst).map(([name, s]) => {{
    const delta = (s.agree_wr !== null && s.disagree_wr !== null)
      ? s.agree_wr - s.disagree_wr : null;
    return {{name, ...s, delta_wr: delta}};
  }});
  rows.sort((a, b) => (b[sortKey] ?? -99) - (a[sortKey] ?? -99));
  tbody.innerHTML = '';
  const overallWR = (() => {{
    let w = 0, n = 0;
    for (const s of Object.values(mst)) {{ w += (s.agree_wr || 0) * (s.agree_n || 0); n += s.agree_n || 0; }}
    return n ? w / n : null;
  }})();
  for (const r of rows) {{
    const awr = r.agree_wr !== null ? (r.agree_wr * 100).toFixed(0) + '%' : '—';
    const dwr = r.disagree_wr !== null ? (r.disagree_wr * 100).toFixed(0) + '%' : '—';
    const delta = r.delta_wr !== null ? (r.delta_wr >= 0 ? '+' : '') + (r.delta_wr * 100).toFixed(0) + '%' : '—';
    const dColor = r.delta_wr !== null && r.delta_wr > 0.05 ? 'color:var(--pos)' :
                   r.delta_wr !== null && r.delta_wr < -0.05 ? 'color:var(--neg)' : '';
    const awrColor = overallWR && r.agree_wr !== null ?
      (r.agree_wr > overallWR + 0.05 ? 'color:var(--pos)' : r.agree_wr < overallWR - 0.05 ? 'color:var(--neg)' : '') : '';
    tbody.innerHTML += `<tr>
      <td style="color:var(--txt)">${{r.name}}</td>
      <td>${{r.agree_n}}</td>
      <td style="${{awrColor}}">${{awr}}</td>
      <td style="color:${{r.disagree_n > 3 ? 'var(--warn)' : 'var(--txt3)'}}">${{r.disagree_n}}</td>
      <td>${{dwr}}</td>
      <td style="${{dColor}}"><b>${{delta}}</b></td>
    </tr>`;
  }}
}}
function _anSortMethods(key) {{ if (_anMethodStats) _renderMethodsTable(_anMethodStats, key); }}

function _drawLineChart(canvasId, data, xKey, yKey, baseline, color, fillArea, label, yRange, refLine) {{
  const canvas = document.getElementById(canvasId);
  if (!canvas || !data.length) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const PAD = {{top: 18, right: 16, bottom: 28, left: 62}};
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  const vals = data.map(d => d[yKey]);
  let yMin = yRange ? yRange[0] : Math.min(...vals);
  let yMax = yRange ? yRange[1] : Math.max(...vals);
  if (baseline !== undefined && !yRange) {{
    yMin = Math.min(yMin, baseline);
    yMax = Math.max(yMax, baseline);
  }}
  const ySpan = yMax - yMin || 1;

  const toX = i => PAD.left + (i / (data.length - 1 || 1)) * cw;
  const toY = v => PAD.top + ch - ((v - yMin) / ySpan) * ch;

  // background
  ctx.fillStyle = '#1A1030';
  ctx.fillRect(0, 0, W, H);

  // grid lines
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {{
    const y = PAD.top + (ch / 4) * i;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cw, y); ctx.stroke();
  }}

  // baseline / refLine
  if (refLine !== undefined) {{
    const ry = toY(refLine);
    ctx.strokeStyle = 'rgba(255,255,255,.2)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(PAD.left, ry); ctx.lineTo(PAD.left + cw, ry); ctx.stroke();
    ctx.setLineDash([]);
  }}

  // fill area
  if (fillArea) {{
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(vals[0]));
    for (let i = 1; i < data.length; i++) ctx.lineTo(toX(i), toY(vals[i]));
    ctx.lineTo(toX(data.length - 1), PAD.top + ch);
    ctx.lineTo(toX(0), PAD.top + ch);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + ch);
    grad.addColorStop(0, color + '44');
    grad.addColorStop(1, color + '00');
    ctx.fillStyle = grad;
    ctx.fill();
  }}

  // line
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.moveTo(toX(0), toY(vals[0]));
  for (let i = 1; i < data.length; i++) ctx.lineTo(toX(i), toY(vals[i]));
  ctx.stroke();

  // Y axis labels
  ctx.fillStyle = 'rgba(160,140,200,.7)';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {{
    const v = yMin + (ySpan / 4) * (4 - i);
    const y = PAD.top + (ch / 4) * i;
    const txt = yRange ? (v * 100).toFixed(0) + '%' : v.toFixed(0);
    ctx.fillText(txt, PAD.left - 4, y + 3);
  }}

  // X labels (first, mid, last)
  ctx.textAlign = 'center';
  const xLabels = [0, Math.floor(data.length / 2), data.length - 1];
  for (const idx of xLabels) {{
    if (data[idx]) {{
      const lbl = data[idx][xKey] !== undefined
        ? (typeof data[idx][xKey] === 'number' ? '#' + data[idx][xKey] : String(data[idx][xKey]).slice(0, 10))
        : '';
      ctx.fillText(lbl, toX(idx), H - 6);
    }}
  }}

  // label
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText(label, PAD.left + 4, PAD.top + 12);
}}

function _drawLearningCurve(canvasId, data) {{
  const canvas = document.getElementById(canvasId);
  if (!canvas || !data.length) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const PAD = {{top: 18, right: 16, bottom: 28, left: 62}};
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  ctx.fillStyle = '#1A1030';
  ctx.fillRect(0, 0, W, H);

  // grid
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {{
    const y = PAD.top + (ch / 4) * i;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cw, y); ctx.stroke();
  }}

  // 50% reference
  ctx.strokeStyle = 'rgba(255,255,255,.2)';
  ctx.setLineDash([4, 4]);
  const r50 = PAD.top + ch * 0.5;
  ctx.beginPath(); ctx.moveTo(PAD.left, r50); ctx.lineTo(PAD.left + cw, r50); ctx.stroke();
  ctx.setLineDash([]);

  const n = data.length;
  const toX = i => PAD.left + (i / (n - 1 || 1)) * cw;
  const toY = v => PAD.top + ch - v * ch;  // v ∈ [0,1]

  // rolling WR
  ctx.beginPath(); ctx.strokeStyle = '#52F2C9'; ctx.lineWidth = 1.5;
  ctx.moveTo(toX(0), toY(data[0].rolling_wr));
  for (let i = 1; i < n; i++) ctx.lineTo(toX(i), toY(data[i].rolling_wr));
  ctx.stroke();

  // cumulative WR (более гладкая)
  ctx.beginPath(); ctx.strokeStyle = '#FF9F40'; ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 3]);
  ctx.moveTo(toX(0), toY(data[0].cum_wr));
  for (let i = 1; i < n; i++) ctx.lineTo(toX(i), toY(data[i].cum_wr));
  ctx.stroke();
  ctx.setLineDash([]);

  // Y labels
  ctx.fillStyle = 'rgba(160,140,200,.7)'; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {{
    const v = 1 - i / 4;
    ctx.fillText((v * 100).toFixed(0) + '%', PAD.left - 4, PAD.top + (ch / 4) * i + 3);
  }}

  // X labels
  ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(160,140,200,.7)';
  const idx3 = [0, Math.floor(n / 2), n - 1];
  for (const idx of idx3) if (data[idx]) ctx.fillText('#' + data[idx].trade_n, toX(idx), H - 6);

  // legend
  ctx.textAlign = 'left'; ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillStyle = '#52F2C9'; ctx.fillText('Rolling WR (20)', PAD.left + 4, PAD.top + 12);
  ctx.fillStyle = '#FF9F40'; ctx.fillText('Cum WR', PAD.left + 130, PAD.top + 12);
}}

// ════════════════════ BAR RULES ════════════════════

async function brPopulateTickers() {{
  try {{
    const r = await fetch('/api/bar_scores_list');
    const files = await r.json();
    const tickers = files.map(f => f.filename.replace(/_\d+d\.csv$/, ''));
    const opts = tickers.map(t => `<option value="${{t}}">${{t}}</option>`).join('');
    const sel = document.getElementById('br_ticker');
    if (sel) sel.innerHTML = opts;
    const sel2 = document.getElementById('br_apply_to');
    if (sel2) sel2.innerHTML = opts;
  }} catch(e) {{}}
}}

async function brRunMiner() {{
  const ticker = document.getElementById('br_ticker').value;
  const target = document.getElementById('br_target').value;
  const depth  = parseInt(document.getElementById('br_depth').value);
  const event_filter = (document.getElementById('br_filter') || {{}}).value || 'all';
  if (!ticker) return;
  const btn = document.getElementById('br_run_btn');
  const status = document.getElementById('br_miner_status');
  btn.disabled = true;
  btn.textContent = '⏳ считаем...';
  status.textContent = `Запускаем майнер для ${{ticker}} (фильтр: ${{event_filter}})...`;
  status.style.color = 'var(--txt3)';
  try {{
    const r = await fetch('/api/bar_rules_mine', {{
      method: 'POST',
      headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{ticker, target, max_depth: depth, event_filter}})
    }});
    const d = await r.json();
    if (d.error) {{
      status.textContent = '✗ ' + d.error;
      status.style.color = 'var(--neg)';
    }} else {{
      status.textContent = `✓ найдено правил (global): ${{d.n_rules_global}}, сохранено → ${{d.path}}`;
      status.style.color = '#52F2C9';
      brRenderRules(d.result);
    }}
  }} catch(e) {{
    status.textContent = '✗ ' + e.message;
    status.style.color = 'var(--neg)';
  }}
  btn.disabled = false;
  btn.textContent = '▶ НАЙТИ ПРАВИЛА';
}}

async function brLoadRules() {{
  const ticker = document.getElementById('br_ticker').value;
  if (!ticker) return;
  const status = document.getElementById('br_miner_status');
  try {{
    const r = await fetch(`/api/bar_rules_load?ticker=${{encodeURIComponent(ticker)}}`);
    const d = await r.json();
    if (d.error) {{
      status.textContent = d.error; status.style.color = 'var(--neg)'; return;
    }}
    status.textContent = `Загружено из ${{d.path}} (от ${{d.computed_at}})`;
    status.style.color = 'var(--txt3)';
    brRenderRules(d.result);
  }} catch(e) {{
    status.textContent = '✗ ' + e.message; status.style.color = 'var(--neg)';
  }}
}}

function brRenderRules(result) {{
  const wrap = document.getElementById('br_rules_wrap');
  if (!result) {{ wrap.innerHTML = ''; return; }}

  const fmtPct = v => {{
    const p = (v * 100).toFixed(3);
    return v >= 0
      ? `<span style="color:#52F2C9">+${{p}}%</span>`
      : `<span style="color:var(--neg)">${{p}}%</span>`;
  }};

  const renderSection = (label, data) => {{
    if (!data || !data.rules || !data.rules.length) return '';
    const base = fmtPct(data.base_avg);
    const top = data.rules.slice(0, 10);
    const rows = top.map(r => {{
      const conds = r.conditions.map(c => `<code style="font-size:10px;background:var(--card);padding:1px 5px;border-radius:4px;">${{c}}</code>`).join(' И ');
      return `<tr>
        <td style="padding:4px 8px;">${{conds}}</td>
        <td style="padding:4px 8px;text-align:right;">${{fmtPct(r.avg_fwd_ret)}}</td>
        <td style="padding:4px 8px;text-align:right;color:var(--txt3);">${{r.n_bars}}</td>
      </tr>`;
    }}).join('');
    return `<div style="margin-bottom:12px;">
      <div style="font-size:11px;font-weight:700;color:var(--txt2);margin-bottom:4px;">
        ${{label}} &nbsp;<span style="font-weight:400;color:var(--txt3);">n=${{data.n_bars}}, base=${{base}}</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:11px;">
        <thead><tr style="color:var(--txt3);">
          <th style="text-align:left;padding:2px 8px;">Условия</th>
          <th style="text-align:right;padding:2px 8px;">avg fwd_ret</th>
          <th style="text-align:right;padding:2px 8px;">баров</th>
        </tr></thead>
        <tbody>${{rows}}</tbody>
      </table>
    </div>`;
  }};

  let html = renderSection('ВСЕ РЕЖИМЫ', result.global);
  const regimes = Object.entries(result.regimes || {{}});
  regimes.sort((a,b) => Math.abs(b[1].base_avg) - Math.abs(a[1].base_avg));
  for (const [rg, data] of regimes) {{
    html += renderSection(rg.toUpperCase(), data);
  }}
  wrap.innerHTML = html || '<div style="color:var(--txt3);font-size:11px;">нет правил</div>';
}}

async function brApplyRules() {{
  const fromTicker = document.getElementById('br_ticker').value;
  const toTicker   = document.getElementById('br_apply_to').value;
  const target     = document.getElementById('br_target').value;
  if (!fromTicker || !toTicker) return;
  const status = document.getElementById('br_apply_status');
  const wrap   = document.getElementById('br_apply_rules_wrap');
  status.textContent = `Применяем правила ${{fromTicker}} → ${{toTicker}}...`;
  status.style.color = 'var(--txt3)';
  wrap.innerHTML = '';
  try {{
    const r = await fetch('/api/bar_rules_apply', {{
      method: 'POST',
      headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{from_ticker: fromTicker, to_ticker: toTicker, target}})
    }});
    const d = await r.json();
    if (d.error) {{
      status.textContent = '✗ ' + d.error;
      status.style.color = 'var(--neg)';
    }} else {{
      status.textContent = `✓ ${{fromTicker}} → ${{toTicker}}: ${{d.n_rules_global}} правил`;
      status.style.color = '#52F2C9';
      wrap.innerHTML = `<div style="font-size:11px;color:var(--txt3);margin-bottom:6px;">
        Правила ${{fromTicker}} проверены на данных ${{toTicker}}
      </div>`;
      const tmpDiv = document.createElement('div');
      brRenderRules(d.result);
      // правила рендерятся в br_rules_wrap — переместим копию
      wrap.innerHTML += document.getElementById('br_rules_wrap').innerHTML;
    }}
  }} catch(e) {{
    status.textContent = '✗ ' + e.message;
    status.style.color = 'var(--neg)';
  }}
}}

// ════════════════════ BAR SCORES ════════════════════

let _bsAllTickers = [];
let _bsBatchRunning = false;

function bsInit() {{
  // читаем тикеры из DOM (#tickers — серверная подстановка, всегда в HTML)
  _bsAllTickers = Array.from(document.querySelectorAll('#tickers input[type=checkbox]'))
    .map(cb => cb.value).filter(Boolean);
  // fallback: если DOM ещё не готов, пробуем через API
  if (!_bsAllTickers.length) {{
    fetch('/api/tickers_list').then(r => r.json()).then(list => {{
      _bsAllTickers = list;
      bsRenderGrid();
    }}).catch(() => {{}});
  }} else {{
    bsRenderGrid();
  }}
  bsLoadFiles();
}}

function bsRenderGrid() {{
  const grid = document.getElementById('bs_ticker_grid');
  if (!_bsAllTickers.length) {{
    grid.innerHTML = '<span style="font-size:11px;color:var(--txt3);">тикеры не найдены — откройте другой таб сначала</span>';
    return;
  }}
  grid.innerHTML = _bsAllTickers.map(t => {{
    return `<label id="bs_chip_${{t}}" style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;background:var(--card);border:1px solid var(--border2);border-radius:999px;cursor:pointer;font-size:11px;font-family:monospace;">
      <input type="checkbox" value="${{t}}" checked style="accent-color:var(--accent);"> ${{t}}
      <span id="bs_status_${{t}}" style="font-size:10px;"></span>
    </label>`;
  }}).join('');
}}

function bsSelectAll() {{
  document.querySelectorAll('#bs_ticker_grid input[type=checkbox]').forEach(cb => cb.checked = true);
}}
function bsSelectNone() {{
  document.querySelectorAll('#bs_ticker_grid input[type=checkbox]').forEach(cb => cb.checked = false);
}}

function bsSetStatus(ticker, status, rows, error) {{
  const el = document.getElementById('bs_status_' + ticker);
  const chip = document.getElementById('bs_chip_' + ticker);
  if (!el) return;
  if (status === 'running') {{
    el.textContent = '⏳';
    el.style.color = 'var(--txt3)';
  }} else if (status === 'done') {{
    el.textContent = `✓ ${{rows}}б`;
    el.style.color = '#52F2C9';
    if (chip) chip.style.borderColor = '#52F2C9';
  }} else if (status === 'error') {{
    el.textContent = '✗';
    el.style.color = 'var(--neg)';
    if (chip) chip.style.borderColor = 'var(--neg)';
    el.title = error || '';
  }}
}}

function bsLog(msg, color) {{
  const log = document.getElementById('bs_progress_log');
  if (!log) return;
  const ts = new Date().toLocaleTimeString('ru');
  const line = document.createElement('div');
  line.style.color = color || 'var(--txt2)';
  line.textContent = `[${{ts}}] ${{msg}}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}}

function bsStartBatch() {{
  if (_bsBatchRunning) return;
  const selected = Array.from(document.querySelectorAll('#bs_ticker_grid input[type=checkbox]:checked'))
    .map(cb => cb.value);
  if (!selected.length) {{ alert('Выбери хотя бы один тикер'); return; }}
  const days = parseInt(document.getElementById('bs_days').value);

  _bsBatchRunning = true;
  document.getElementById('bs_run_btn').disabled = true;
  document.getElementById('bs_run_btn').textContent = '⏳ качаем...';
  document.getElementById('bs_progress_wrap').style.display = '';
  document.getElementById('bs_progress_log').innerHTML = '';
  bsLog(`Старт: ${{selected.length}} тикеров, ${{days}} дней`, 'var(--accent)');

  const url = `/api/bar_scores_batch?tickers=${{encodeURIComponent(selected.join(','))}}&days=${{days}}`;
  const es = new EventSource(url);

  es.addEventListener('progress', e => {{
    const d = JSON.parse(e.data);
    if (d.status === 'running') {{
      bsSetStatus(d.ticker, 'running');
      bsLog(`${{d.ticker}}: загружаем...`, 'var(--txt3)');
    }} else if (d.status === 'done') {{
      bsSetStatus(d.ticker, 'done', d.rows);
      bsLog(`${{d.ticker}}: ✓ ${{d.rows}} баров сохранено`, '#52F2C9');
    }} else if (d.status === 'error') {{
      bsSetStatus(d.ticker, 'error', 0, d.error);
      bsLog(`${{d.ticker}}: ✗ ${{d.error}}`, 'var(--neg)');
    }}
  }});

  es.addEventListener('done', e => {{
    es.close();
    _bsBatchRunning = false;
    document.getElementById('bs_run_btn').disabled = false;
    document.getElementById('bs_run_btn').textContent = '▶ КАЧАТЬ';
    bsLog('Готово!', 'var(--accent)');
    bsLoadFiles();
  }});

  es.onerror = () => {{
    es.close();
    _bsBatchRunning = false;
    document.getElementById('bs_run_btn').disabled = false;
    document.getElementById('bs_run_btn').textContent = '▶ КАЧАТЬ';
    bsLog('Соединение прервано', 'var(--neg)');
  }};
}}

async function bsLoadFiles() {{
  const wrap = document.getElementById('bs_files_wrap');
  wrap.innerHTML = '<div style="font-size:11px;color:var(--txt3);">загружаем...</div>';
  try {{
    const r = await fetch('/api/bar_scores_list');
    const files = await r.json();
    if (!files.length) {{
      wrap.innerHTML = '<div style="font-size:11px;color:var(--txt3);">нет сохранённых файлов</div>';
      return;
    }}
    let html = `<table class="scen-table"><thead><tr>
      <th>Файл</th><th>Размер</th><th>Дата</th><th></th>
    </tr></thead><tbody>`;
    for (const f of files) {{
      html += `<tr>
        <td style="font-family:monospace;font-size:11px;">${{f.filename}}</td>
        <td>${{f.size_kb}} KB</td>
        <td style="color:var(--txt3);">${{f.mtime}}</td>
        <td><a href="/api/bar_scores_download?file=${{encodeURIComponent(f.filename)}}"
               download="${{f.filename}}"
               class="btn-pill btn-sm" style="text-decoration:none;display:inline-block;">⬇ скачать</a></td>
      </tr>`;
    }}
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }} catch(e) {{
    wrap.innerHTML = `<div style="color:var(--neg);font-size:11px;">ошибка: ${{e.message}}</div>`;
  }}
}}

</script>
</body>
</html>
"""


def _oi_import_tickers_only() -> set[str]:
    """Тикеры, которые попадают в общий список ТОЛЬКО из-за старого импорта
    oi_tickers.json (merge_oi_tickers, экспорт из oi-signal-v10.html) — не
    сконфигурированы ни в settings.ini STRATEGY_*, ни резолвятся как
    фьючерс из [FUTURES_TRADING]. Импорт ничего не удаляет и не устаревает
    сам — это единственный способ их отличить от «настоящих» тикеров."""
    ini_tickers = {s.ticker for s in _config.trade_strategy_settings}
    futures_tickers = set(_futures_settings_by_ticker().keys())
    return set(load_oi_tickers().keys()) - ini_tickers - futures_tickers


def get_overrides_payload() -> dict:
    """Текущий data/bot_overrides.json + полный список тикеров (settings.ini + OI) для таблицы."""
    data = load_overrides()
    oi_only = _oi_import_tickers_only()
    tickers_all = sorted(set(_all_settings_by_ticker().keys()) | set(load_oi_tickers().keys()))
    # Источник тикера — чтобы в таблице было видно, откуда он взялся, и чтобы
    # предложить удаление только для тех, что держатся исключительно на
    # старом импорте (settings.ini/FUTURES_TRADING трогать нет смысла — они
    # просто появятся заново на следующей перезагрузке страницы).
    from candle_archive import _local_cache_path
    oi_removable = {}
    for t in oi_only:
        has_cache = os.path.exists(_local_cache_path(t)) or os.path.exists(_local_cache_path(t, 1))
        oi_removable[t] = {"has_cache": has_cache}
    return {
        "global_signal_only": data.get("global_signal_only"),
        "partial_tp_enabled": data.get("partial_tp_enabled"),
        "adaptive_exit_enabled": data.get("adaptive_exit_enabled"),
        "orderbook_enabled": data.get("orderbook_enabled"),
        "paused": data.get("paused", False),
        "daily_max_loss_pct": data.get("daily_max_loss_pct"),
        "weekly_max_loss_pct": data.get("weekly_max_loss_pct"),
        "monthly_max_loss_pct": data.get("monthly_max_loss_pct"),
        "tickers": data.get("tickers", {}),
        "tickers_all": tickers_all,
        # {ticker: {has_cache}} — только для тикеров, держащихся исключительно
        # на импорте oi_tickers.json (кандидаты на удаление из UI).
        "oi_import_only": oi_removable,
    }


def delete_oi_ticker(ticker: str) -> dict:
    """Убирает один тикер из oi_tickers.json (единственный способ его туда
    когда-либо попавший — merge_oi_tickers). Не трогает settings.ini/кэш
    фьючерсов — если тикер сконфигурирован там, он и не был бы в oi_tickers
    единственным источником, см. _oi_import_tickers_only."""
    current = load_oi_tickers()
    if ticker not in current:
        return {"ok": False, "error": "тикер не найден в oi_tickers.json"}
    del current[ticker]
    atomic_write_json(OI_TICKERS_FILE, current, indent=2)
    return {"ok": True}


def prune_stale_oi_tickers() -> dict:
    """Массово убирает из oi_tickers.json тикеры, которые (а) держатся только
    на этом импорте (не в settings.ini/FUTURES_TRADING) и (б) не имеют ни
    одного локально закэшированного файла свечей — то есть по ним никогда
    не гонялся бэктест/график на этой машине. Это и есть тот самый «хлам без
    истории» — импортирован когда-то из oi-signal-v10.html, ни разу не
    использован, с тех пор просто занимает строку в каждом списке тикеров."""
    from candle_archive import _local_cache_path
    oi_only = _oi_import_tickers_only()
    current = load_oi_tickers()
    removed = []
    for t in oi_only:
        has_cache = os.path.exists(_local_cache_path(t)) or os.path.exists(_local_cache_path(t, 1))
        if not has_cache and t in current:
            del current[t]
            removed.append(t)
    if removed:
        atomic_write_json(OI_TICKERS_FILE, current, indent=2)
    return {"ok": True, "removed": sorted(removed), "count": len(removed)}


# Ошибочные статусы, за которые тикер попадает в кандидаты на очистку.
# «нет истории» — Tinkoff API не смог отдать свечи (мёртвый фьючерс/делистинг);
# «ошибка API» — RequestError на этапе запроса свечей (обычно тоже мёртвый);
# «ошибка» — необработанное исключение в самом бэктесте (баг данных, а не бота).
_PRUNE_FAILED_STATUSES = {"нет истории", "ошибка API", "ошибка"}


def prune_failed_oi_tickers(statuses_snapshot: dict | None = None) -> dict:
    """Убирает из oi_tickers.json тикеры, которые в последнем прогоне попали
    в _PRUNE_FAILED_STATUSES (нет истории / ошибка API / ошибка). Работает по
    той же логике безопасности, что prune_stale: только тикеры из oi_only
    (в settings.ini/FUTURES_TRADING не трогаются — они появятся заново на
    следующей перезагрузке в любом случае, оттуда их удалять нужно вручную).

    statuses_snapshot — если задан, используется он ({ticker: status_str});
    иначе берётся текущий _progress. Явный параметр нужен для тестируемости.
    Клиент обычно передаёт свой снимок из UI, чтобы результат совпадал с тем,
    что пользователь видит в таблице."""
    if statuses_snapshot is None:
        progress = _get_progress_proxy()
        # dict(progress) — снимок через Manager-proxy, dict возвращает
        # {ticker: {"status": ..., "ts": ...}}
        try:
            snap = dict(progress)
        except Exception:
            snap = {}
        statuses_snapshot = {tk: v.get("status") for tk, v in snap.items()
                              if isinstance(v, dict)}

    oi_only = set(_oi_import_tickers_only())
    current_oi = load_oi_tickers()
    settings_by_ticker = _all_settings_by_ticker()
    overrides = load_overrides()
    overrides_tickers = overrides.setdefault("tickers", {})

    failed_all = [tk for tk, st in statuses_snapshot.items()
                    if st in _PRUNE_FAILED_STATUSES]
    # Ветвим по источнику тикера:
    # (а) держится только на oi_tickers.json → удаляем из файла
    # (б) сконфигурирован в settings.ini → нельзя удалить программно
    #     (это пользовательский конфиг), но можно отключить через overrides:
    #     enabled=false → бот в проде игнорирует. Для бэктестного UI
    #     пользователь снимает чипсу вручную (или чекбокс в этой же панели).
    # (в) неизвестный источник — редко: свежий одноразовый backtest, тикер
    #     не сохранён ни там ни там. Пропускаем, сообщаем в отчёте.
    removed_from_oi = []
    disabled_in_overrides = []
    already_disabled = []
    unknown = []
    for t in failed_all:
        if t in current_oi and t in oi_only:
            del current_oi[t]
            removed_from_oi.append(t)
            continue
        if t in settings_by_ticker:
            cur = overrides_tickers.get(t, {})
            if cur.get("enabled") is False:
                already_disabled.append(t)
            else:
                cur["enabled"] = False
                overrides_tickers[t] = cur
                disabled_in_overrides.append(t)
            continue
        unknown.append(t)

    if removed_from_oi:
        atomic_write_json(OI_TICKERS_FILE, current_oi, indent=2)
    if disabled_in_overrides:
        save_overrides(overrides)

    return {
        "ok": True,
        "removed_from_oi": sorted(removed_from_oi),
        "disabled_in_overrides": sorted(disabled_in_overrides),
        "already_disabled": sorted(already_disabled),
        "unknown_source": sorted(unknown),
        "total_failed_in_run": len(failed_all),
    }


def get_live_chart(ticker: str, days: int = 7) -> dict:
    """Свечи из candle_archive + реальные сделки из data/trades.jsonl для живого графика."""
    try:
        from candle_archive import get_candles_cached, _candle_to_row
    except ImportError:
        return {"error": "candle_archive недоступен"}

    by_ticker = _all_settings_by_ticker()
    strategy_settings = by_ticker.get(ticker)
    if strategy_settings is None:
        return {"error": f"{ticker}: нет в настройках"}

    try:
        candles = get_candles_cached(ticker, strategy_settings.figi, days, _market_data, _db)
    except Exception as e:
        return {"error": str(e)}

    candle_rows = [_candle_to_row(c) for c in candles]

    # Реальные сделки из trades.jsonl
    import metrics as _metrics
    trades_raw = _metrics.load_closed_trades(500)
    ticker_trades = [t for t in trades_raw if t.get("ticker") == ticker]

    # Также открытые позиции из bot_status
    status = get_bot_status()
    open_positions = [p for p in status.get("positions", []) if p.get("ticker") == ticker]

    trades_out = []
    for t in ticker_trades:
        trades_out.append({
            "entry_time": t.get("ts"),       # время закрытия — близко к выходу
            "exit_time": t.get("closed_ts") or t.get("ts"),
            "direction": t.get("direction", "").lower(),
            "entry_price": t.get("entry"),
            "exit_price": t.get("exit_price") or t.get("close_price"),
            "stop_price": t.get("stop"),
            "take_price": t.get("take"),
            "pnl_rub": t.get("pnl_rub"),
            "net_pct": round(t["pnl_rub"] / max(t.get("entry", 1), 1) * 100, 3) if t.get("pnl_rub") is not None else None,
            "reason": t.get("reason", ""),
        })

    for p in open_positions:
        trades_out.append({
            "entry_time": p.get("opened_at"),
            "exit_time": None,
            "direction": (p.get("direction") or "").lower(),
            "entry_price": p.get("entry_price"),
            "exit_price": None,
            "stop_price": p.get("stop"),
            "take_price": p.get("take"),
            "pnl_rub": None,
            "net_pct": None,
            "reason": "открыта",
        })

    return {"ticker": ticker, "candles": candle_rows, "trades": trades_out}


def get_scorecard_api() -> dict:
    """Scorecard + per_ticker stats + kelly для живого дашборда."""
    import metrics as _metrics
    card = _metrics.scorecard()
    kelly_pct, _ = _metrics.dynamic_risk_pct()

    # Per-ticker
    trades = _metrics.load_closed_trades(10_000)
    by_ticker: dict = {}
    for t in trades:
        tk = t.get("ticker", "?")
        by_ticker.setdefault(tk, []).append(t.get("pnl_rub", 0))
    per_ticker = []
    for tk, pnls in sorted(by_ticker.items(), key=lambda x: -sum(x[1])):
        wins = sum(1 for p in pnls if p > 0)
        per_ticker.append({
            "ticker": tk,
            "n": len(pnls),
            "total": round(sum(pnls), 2),
            "wr": round(wins / len(pnls), 3) if pnls else 0,
        })

    return {**card, "kelly_pct": round(kelly_pct, 2), "per_ticker": per_ticker}


def get_council_log() -> dict:
    """Последние уроки консилиума из data/council_lessons.json."""
    import council as _council
    lessons = _council._load_lessons()
    return {"lessons": lessons}


def council_ask_sync(ticker: str, question: str, direction: str = "LONG") -> dict:
    """Синхронный вызов консилиума из дашборда (с таймаутом 35с)."""
    import asyncio
    try:
        import council as _council
        from trade_analytics import full_report_for_council
        analytics = full_report_for_council(ticker) if ticker else question
        snap = {"regime": "unknown", "composite": 0.0, "scores": {}, "atr_pct": 0.0}
        coro = _council.consult_signal(ticker or "?", direction, snap, analytics_text=question or analytics, timeout=35.0)
        try:
            loop = asyncio.get_event_loop()
            if loop.is_closed():
                raise RuntimeError
            result = loop.run_until_complete(coro)
        except RuntimeError:
            result = asyncio.run(coro)
        return {"ok": True, "result": result}
    except Exception as e:
        return {"ok": False, "error": str(e)}


_oi_backfill_job: dict = {}  # {running, log, total_new, error, done}
_oi_backfill_lock = __import__("threading").Lock()


def run_oi_backfill(months: int, tickers: list[str] | None = None) -> dict:
    """Запускает backfill в фоновом потоке. Возвращает сразу."""
    import threading
    import backfill_oi

    with _oi_backfill_lock:
        if _oi_backfill_job.get("running"):
            return {"started": False, "error": "уже запущен — дождись завершения"}

        token = backfill_oi._get_token()
        if not token:
            return {"started": False, "error": "MOEX_TOKEN не задан в env или settings.ini [MOEX] TOKEN=..."}

        target_tickers = tickers or backfill_oi._get_strategy_tickers() or list(backfill_oi.FUTOI_MAP.keys() if hasattr(backfill_oi, "FUTOI_MAP") else [])
        if not target_tickers:
            return {"started": False, "error": "Нет тикеров: добавь STRATEGY_* секции в settings.ini или укажи вручную"}

        _oi_backfill_job.clear()
        _oi_backfill_job.update({"running": True, "log": [], "total_new": 0, "error": None, "done": False, "tickers": target_tickers})

    def _worker():
        try:
            result = backfill_oi.backfill(target_tickers, months, token)
            with _oi_backfill_lock:
                _oi_backfill_job.update({"running": False, "done": True,
                                         "total_new": result.get("total_new", 0),
                                         "log": result.get("log", [])})
        except Exception as e:
            with _oi_backfill_lock:
                _oi_backfill_job.update({"running": False, "done": True, "error": str(e)})

    threading.Thread(target=_worker, daemon=True).start()
    return {"started": True, "tickers": target_tickers}


def get_oi_backfill_status() -> dict:
    with _oi_backfill_lock:
        return dict(_oi_backfill_job)


def _get_oi_api_url() -> str:
    """URL OI-воркера из env OI_API_URL или settings.ini [OI_API] URL=."""
    url = os.getenv("OI_API_URL")
    if url:
        return url.strip()
    ini = __import__("configparser").ConfigParser()
    ini.read(os.path.join(os.path.dirname(__file__), "settings.ini"), encoding="utf-8")
    return (ini.get("OI_API", "URL", fallback="") or "").strip()


_oi_autosync_at: dict = {}  # ticker(upper) -> monotonic ts последней авто-подтяжки
_oi_autosync_lock = __import__("threading").Lock()
OI_AUTOSYNC_TTL_SEC = 300   # не дёргать воркер по тому же тикеру чаще, чем раз в 5 мин
# Мягкий лимит на прямой MOEX-сбор OI перед бэктестом. Без него вселенная с
# десятками непокрытых фьючерсов (каждый — сотни дневных запросов × 0.4с)
# вешала прогон на часы, прогресс замирал на 0/N. Непокрытое дособирается
# инкрементально на следующих прогонах. Можно поднять для полного покрытия.
OI_BACKFILL_BUDGET_SEC = 90.0


def _oi_base_resolver():
    """Офлайн-резолвер: код фьючерса → базовый актив/имя для спеки OI (жалоба
    «непонятно какая база»). Источники по убыванию точности, всё с диска, сеть
    не трогаем: futures_cache.json (base→контракт, реверс по КОРНЮ) →
    oi_tickers.json[code].name. Нет совпадения → None (в сводке покажется корень)."""
    import oi_layers
    root2base: dict[str, str] = {}
    try:
        contracts, _ = _futures_cache_from_disk()
        for base, info in (contracts or {}).items():
            tk = (info or {}).get("ticker") or ""
            if tk:
                root2base[oi_layers._contract_root(tk).upper()] = base
    except Exception:
        pass
    names: dict[str, str] = {}
    try:
        names = {k.upper(): (v.get("name") or "") for k, v in load_oi_tickers().items()}
    except Exception:
        pass

    def resolve(code: str):
        up = (code or "").upper()
        r = oi_layers._contract_root(code).upper()
        if r in root2base:
            return root2base[r]
        nm = names.get(up, "")
        return nm if nm and nm.upper() != up else None
    return resolve


def ensure_oi_synced(tickers: list[str], days: int | None = None, offset_days: int = 0) -> None:
    """Перед бэктестом дозабирает свежий ОИ в data/oi_daily.json.
    Best-effort: нет URL / сеть упала — молча идём на том, что есть локально.
    Троттлинг по тикеру (TTL), чтобы не дёргать воркер на каждый прогон.
    Вызывать в РОДИТЕЛЬСКОМ процессе один раз до запуска пула (подпроцессы
    читают уже готовый файл).

    days/offset_days: если заданы (период прогона) и настроен MOEX-токен —
    непокрытые воркером коды дособираются ПРЯМО с MOEX по коду контракта
    (backfill_oi.backfill_by_codes). Именно этого не хватало: авто-поток ходил
    только в предсобранный воркер, а на MOEX за произвольным фьючерсом — нет,
    поэтому OI по нестандартной вселенной был всегда пуст. Первый прогон новой
    вселенной может занять минуты (инкрементально — дальше быстро)."""
    import oi_layers
    _oi_path = os.path.join(os.path.dirname(__file__), "data", "oi_daily.json")
    url = _get_oi_api_url()
    _base_res = _oi_base_resolver()
    if url and tickers:
        now = time.monotonic()
        with _oi_autosync_lock:
            due = [t for t in tickers
                   if now - _oi_autosync_at.get(t.upper(), 0.0) > OI_AUTOSYNC_TTL_SEC]
            for t in due:
                _oi_autosync_at[t.upper()] = now
        if due:
            try:
                res = oi_layers.sync_worker_oi(url, due, path=_oi_path)
                logger.info(f"OI автоподтяжка из воркера: {res.get('total')} дней всего по {len(due)} тик.")
            except Exception as e:
                logger.warning(f"OI автоподтяжка не удалась (идём на локальных данных): {e}")
    # Спека покрытия — на КАЖДОМ прогоне в лог, даже если синк пропущен (нет URL/
    # троттлинг): чтобы отсутствие OI по вселенной было видно сразу, а не по нулям
    # скоров постфактум. Сеть не трогает — читает уже собранный файл.
    try:
        spec = oi_layers.build_oi_spec(tickers, path=_oi_path, base_resolver=_base_res)
        logger.info(oi_layers.oi_coverage_summary(spec))
    except Exception:
        spec = []

    # Прямой сбор с MOEX по коду для непокрытых воркером — если знаем период прогона
    # и есть MOEX-токен. Best-effort: любая ошибка → идём на том, что есть.
    if days:
        try:
            import backfill_oi
            token = backfill_oi._get_token()
            uncovered = [s["code"] for s in spec if not s["has_oi"]]
            if token and uncovered:
                date_till = today_msk() - datetime.timedelta(days=int(offset_days or 0))
                # +260 кал.дней запаса на прогрев перцентильных окон signal_gate (60/60).
                date_from = date_till - datetime.timedelta(days=int(days) + 260)
                # Бюджет: без него сбор по десяткам непокрытых фьючерсов
                # (каждый — сотни дневных MOEX-запросов × 0.4с паузы) вешал
                # бэктест на ЧАСЫ, прогресс замирал на 0/N. Собираем сколько
                # успеваем в OI_BACKFILL_BUDGET_SEC, остальное дособерётся
                # инкрементально на следующих прогонах (best-effort и так).
                logger.info(f"OI: прямой сбор с MOEX по {len(uncovered)} непокрытым кодам "
                            f"за {date_from}…{date_till} (бюджет {OI_BACKFILL_BUDGET_SEC:.0f}с; "
                            f"непокрытое дособерётся на следующих прогонах)")
                res = backfill_oi.backfill_by_codes(uncovered, date_from, date_till, token,
                                                     budget_sec=OI_BACKFILL_BUDGET_SEC)
                spec2 = oi_layers.build_oi_spec(tickers, path=_oi_path, base_resolver=_base_res)
                logger.info(f"OI прямой сбор: +{res.get('added_total')} дней · "
                            + oi_layers.oi_coverage_summary(spec2))
            elif uncovered and not token:
                logger.warning(f"OI: {len(uncovered)} кодов без покрытия, но MOEX-токен не задан "
                               f"([MOEX] TOKEN=) — прямой сбор пропущен")
        except Exception as e:
            logger.warning(f"OI прямой сбор с MOEX не удался (идём на том, что есть): {e}")


def oi_worker_catalog(tickers: list[str] | None = None) -> dict:
    """Диагностика: что реально лежит в OI-воркере (/db/tickers) и находится ли
    матч под наши тикеры. Помогает понять расхождение форматов кодов."""
    import oi_layers
    import backfill_oi
    url = _get_oi_api_url()
    if not url:
        return {"ok": False, "error": "URL OI-воркера не задан ([OI_API] URL=)"}
    try:
        catalog = oi_layers._worker_get(url, "/db/tickers")
    except Exception as e:
        return {"ok": False, "error": f"/db/tickers упал: {e}"}
    catalog = catalog or []
    target = tickers or backfill_oi._get_strategy_tickers()
    probes = []
    for tk in (target or []):
        try:
            rows = oi_layers.fetch_worker_oi_daily(url, tk)
        except Exception as e:
            probes.append({"ticker": tk, "matched": False, "days": 0, "error": str(e)})
            continue
        probes.append({
            "ticker": tk, "matched": bool(rows), "days": len(rows),
            "src": (rows[0].get("src_ticker") if rows else None),
            "root": oi_layers._contract_root(tk),
        })
    return {"ok": True, "catalog": catalog, "probes": probes,
            "catalog_n": len(catalog)}


def oi_sync_from_worker(tickers: list[str] | None = None) -> dict:
    """Тянет oi_daily из OI-воркера (D1) в локальный data/oi_daily.json.
    Без tickers — берёт акционные тикеры из STRATEGY_* секций settings.ini."""
    import oi_layers
    import backfill_oi
    url = _get_oi_api_url()
    if not url:
        return {"ok": False, "error": "URL OI-воркера не задан ([OI_API] URL= в settings.ini)"}
    target = tickers or backfill_oi._get_strategy_tickers()
    if not target:
        return {"ok": False, "error": "Нет тикеров: добавь STRATEGY_* в settings.ini или укажи вручную"}
    try:
        res = oi_layers.sync_worker_oi(url, target,
                                       path=os.path.join(os.path.dirname(__file__), "data", "oi_daily.json"))
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "total": res["total"], "summary": res["summary"], "log": res["log"]}


# ── Управление процессом бота (старт/стоп) ───────────────────────────────────

def supervisor_start(sandbox: bool) -> dict:
    return bot_supervisor.start_bot(sandbox)


def supervisor_stop() -> dict:
    return bot_supervisor.stop_bot()


def supervisor_force_kill() -> dict:
    return bot_supervisor.force_kill_bot()


def supervisor_status() -> dict:
    return bot_supervisor.status()


def supervisor_log(n_lines: int = 200) -> dict:
    return {"log": bot_supervisor.tail_log(n_lines)}


# ── Гибкий выбор тикеров (ticker_universe.py) ────────────────────────────────

_universe_compute_running = threading.Event()
_universe_compute_lock = threading.Lock()


def universe_get() -> dict:
    cfg = ticker_universe.load_universe()
    cfg["candidates_catalog"] = ticker_universe.candidates_catalog(cfg.get("extra_candidates"))
    cfg["classify"] = {b: ticker_universe.classify(b) for b in cfg["candidates_catalog"]}
    cfg["computing"] = _universe_compute_running.is_set()
    return cfg


def _universe_compute_bg(candidates: list[str]) -> None:
    try:
        ma = MegaAlertsService()
        hits = ma.hits_last_days(7)
        scores = ticker_universe.compute_demand_scores(
            candidates, _instrument_service, _market_data, hits,
        )
        cfg = ticker_universe.load_universe()
        cfg["last_scores"] = scores
        cfg["computed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        ticker_universe.save_universe(cfg)
        logger.info(f"ticker_universe: посчитан спрос для {len(scores)} кандидатов")
    except Exception as e:
        logger.error(f"ticker_universe: расчёт упал: {repr(e)}")
    finally:
        _universe_compute_running.clear()


def universe_compute(candidates: list[str] | None) -> dict:
    if _universe_compute_running.is_set():
        return {"ok": False, "error": "расчёт уже идёт"}
    cfg = ticker_universe.load_universe()
    pool = candidates or ticker_universe.candidates_catalog(cfg.get("extra_candidates"))
    _universe_compute_running.set()
    threading.Thread(target=_universe_compute_bg, args=(pool,), daemon=True).start()
    return {"ok": True, "started": True, "n_candidates": len(pool)}


def universe_save(payload: dict) -> dict:
    cfg = ticker_universe.load_universe()
    mode = payload.get("mode", cfg["mode"])
    if mode not in ("manual", "top_n"):
        return {"ok": False, "error": f"неизвестный режим: {mode}"}
    cfg["mode"] = mode
    if "manual_tickers" in payload:
        cfg["manual_tickers"] = [t.strip() for t in payload["manual_tickers"] if str(t).strip()]
    if "top_n" in payload:
        tn = payload["top_n"]
        cfg["top_n"] = {
            "n": max(1, int(tn.get("n", cfg["top_n"]["n"]))),
            "include_types": tn.get("include_types", cfg["top_n"]["include_types"]),
            "exclude_types": tn.get("exclude_types", cfg["top_n"]["exclude_types"]),
        }
    if "extra_candidates" in payload:
        cfg["extra_candidates"] = [t.strip() for t in payload["extra_candidates"] if str(t).strip()]

    if mode == "manual":
        cfg["resolved_tickers"] = list(cfg["manual_tickers"])
    else:
        scores = cfg.get("last_scores") or {}
        if not scores:
            return {"ok": False, "error": "сначала нажми «Посчитать» — нет данных для топ-N"}
        cfg["resolved_tickers"] = ticker_universe.resolve_top_n(
            scores, cfg["top_n"]["n"], cfg["top_n"]["include_types"], cfg["top_n"]["exclude_types"]
        )
    ticker_universe.save_universe(cfg)
    return {"ok": True, "resolved_tickers": cfg["resolved_tickers"]}


def get_bot_status() -> dict:
    """data/bot_status.json — живой снимок, который бот обновляет на каждой свече."""
    path = "data/bot_status.json"
    if not os.path.exists(path):
        return {"running": False}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        data["running"] = True
        return data
    except (OSError, json.JSONDecodeError):
        return {"running": False}


def bot_move_stop(ticker: str, new_stop: float, new_take: float | None) -> dict:
    """Пишет MoveStopRequest в bot_overrides.json."""
    data = load_overrides()
    reqs = data.get("move_stop_requests", [])
    req: dict = {"ticker": ticker.upper(), "new_stop": str(new_stop)}
    if new_take is not None:
        req["new_take"] = str(new_take)
    reqs.append(req)
    data["move_stop_requests"] = reqs
    save_overrides(data)
    return {"ok": True}


def bot_adopt_position(ticker: str, direction: str, take: float, stop: float, entry: float | None) -> dict:
    """Пишет AdoptRequest в bot_overrides.json — бот подхватит на следующей свече."""
    data = load_overrides()
    reqs = data.get("adopt_requests", [])
    reqs.append({
        "ticker": ticker.upper(),
        "direction": direction.upper(),
        "take": str(take),
        "stop": str(stop),
        "entry": str(entry) if entry is not None else None,
    })
    data["adopt_requests"] = reqs
    save_overrides(data)
    return {"ok": True}


def bot_control_action(action: str, ticker: str = "") -> dict:
    """pause / resume / close (ticker или 'ALL') — пишем в bot_overrides.json."""
    data = load_overrides()
    if action == "pause":
        data["paused"] = True
    elif action == "resume":
        data["paused"] = False
    elif action == "close":
        t = ticker.strip().upper() or "ALL"
        reqs = list(data.get("close_requests", []))
        if t not in reqs:
            reqs.append(t)
        data["close_requests"] = reqs
    else:
        return {"error": f"неизвестное действие: {action}"}
    save_overrides(data)
    return {"ok": True, "paused": data.get("paused", False)}


# ── MOEX AlgoPack токен: смена с дашборда без правки settings.ini руками ────
# Живые поллеры (oi_layers.py/mega_alerts.py/tradestats.py) читают токен
# заново на каждый запрос (env MOEX_TOKEN в приоритете, иначе этот файл) —
# правка ниже подхватывается их обычным циклом (до 5 мин), рестарт не нужен.
SETTINGS_INI_PATH = "settings.ini"


def get_moex_token_status() -> dict:
    """{configured, masked, source} — не отдаёт токен целиком на фронт."""
    import os as _os
    env_token = _os.getenv("MOEX_TOKEN")
    if env_token:
        return {"configured": True, "masked": f"…{env_token[-6:]}", "source": "env (приоритет над settings.ini)"}
    try:
        from configparser import ConfigParser
        ini = ConfigParser()
        ini.read(SETTINGS_INI_PATH, encoding="utf-8")
        token = ini.get("MOEX", "TOKEN", fallback="") or ""
    except Exception:
        token = ""
    if not token:
        return {"configured": False, "masked": "", "source": ""}
    return {"configured": True, "masked": f"…{token[-6:]}", "source": "settings.ini [MOEX] TOKEN="}


def save_moex_token(new_token: str) -> dict:
    """Точечная текстовая замена TOKEN= внутри [MOEX] — НЕ через ConfigParser,
    иначе он перезапишет весь файл и уничтожит все комментарии settings.ini
    (там держится вся эксплуатационная документация проекта). Если задан env
    MOEX_TOKEN — он всё равно будет иметь приоритет над файлом при следующем
    чтении (тот же порядок, что везде в проекте); предупреждаем об этом."""
    import os as _os
    new_token = (new_token or "").strip()
    if not new_token:
        return {"error": "пустой токен"}
    try:
        with open(SETTINGS_INI_PATH, encoding="utf-8") as f:
            lines = f.readlines()
    except OSError as e:
        return {"error": f"не удалось прочитать {SETTINGS_INI_PATH}: {e}"}

    in_moex = False
    replaced = False
    out_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            in_moex = (stripped == "[MOEX]")
        if in_moex and stripped.startswith("TOKEN=") and not replaced:
            out_lines.append(f"TOKEN={new_token}\n")
            replaced = True
            continue
        out_lines.append(line)

    if not replaced:
        return {"error": "секция [MOEX] TOKEN= не найдена в settings.ini — впиши её вручную один раз"}

    tmp = SETTINGS_INI_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.writelines(out_lines)
    _os.replace(tmp, SETTINGS_INI_PATH)

    warning = None
    if _os.getenv("MOEX_TOKEN"):
        warning = "env MOEX_TOKEN тоже задан и имеет приоритет — новый токен из файла не будет использован, пока не убрана переменная окружения"
    return {"ok": True, "masked": f"…{new_token[-6:]}", "warning": warning}


METHOD_PRESETS_FILE = "data/method_presets.json"


def get_method_presets() -> dict:
    """Все сохранённые пресеты методов {имя: {disabled, inverted, saved_at}}."""
    try:
        with open(METHOD_PRESETS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_method_preset(name: str, disabled: list, inverted: list) -> dict | None:
    """Сохраняет набор disabled/inverted под именем — переживает рестарт дашборда.
    Возвращает None при успехе, {"error"} при пустом имени."""
    name = (name or "").strip()
    if not name:
        return {"error": "пустое имя пресета"}
    presets = get_method_presets()
    presets[name] = {
        "disabled": sorted(set(disabled or [])),
        "inverted": sorted(set(inverted or [])),
        "saved_at": time.time(),
    }
    atomic_write_json(METHOD_PRESETS_FILE, presets, indent=2)
    return None


def delete_method_preset(name: str) -> None:
    presets = get_method_presets()
    if name in presets:
        del presets[name]
        atomic_write_json(METHOD_PRESETS_FILE, presets, indent=2)


# ── Текущее состояние вкл/выкл методов (переживает перезагрузку страницы) ──
# В отличие от именованных пресетов (сохраняются вручную кнопкой), это —
# автосохранение при каждом изменении чекбоксов. Раньше чекбоксы верхней
# панели всегда стартовали пустыми при загрузке страницы, а низ (глобальная
# статистика прогона) держал disabled-флаг из уже посчитанных результатов —
# после reload это расходилось: внизу метод показан выключенным, вверху
# чекбокс снят, и непонятно, что реально применится в следующем прогоне.
METHOD_TOGGLE_STATE_FILE = "data/method_toggle_state.json"


def get_method_toggle_state() -> dict:
    try:
        with open(METHOD_TOGGLE_STATE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return {"disabled": data.get("disabled") or [], "inverted": data.get("inverted") or []}
    except (FileNotFoundError, json.JSONDecodeError):
        return {"disabled": [], "inverted": []}


def save_method_toggle_state(disabled: list, inverted: list) -> None:
    atomic_write_json(
        METHOD_TOGGLE_STATE_FILE,
        {"disabled": sorted(set(disabled or [])), "inverted": sorted(set(inverted or []))},
        indent=2,
    )


def get_method_calibration() -> dict:
    """Диагностика адаптивной калибровки индикаторов на РЕАЛЬНЫХ данных: читает
    method_params.json (его пишет бот при еженедельном пересчёте) и возвращает
    по каждому тикеру, что адаптировалось, OOS-edge выбранного vs классики, λ,
    согласованность. Позволяет глазами оценить осмысленность адаптаций на живом
    рынке — то, что синтетика проверить не может."""
    try:
        from method_calibrator import MethodCalibrator
    except Exception as exc:
        return {"error": f"калибратор недоступен: {exc}", "tickers": {}}
    # Тот же файл, что пишет бот (репозиторный корень = каталог dashboard.py).
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "method_params.json")
    if not os.path.exists(path):
        return {"error": "method_params.json ещё не создан — бот не пересчитывал калибровку",
                "tickers": {}}
    try:
        cal = MethodCalibrator(store_path=path)
        return {"tickers": cal.report()}
    except Exception as exc:
        return {"error": f"не удалось прочитать калибровку: {exc}", "tickers": {}}


# ── Снимки обученных весов (data/weights_snapshots/*.json) ──────────────────
WEIGHTS_SNAPSHOTS_DIR = "data/weights_snapshots"
OI_WEIGHTS_FILE = "oi_weights.json"


def _safe_snap_name(name: str) -> str:
    """Безопасное имя файла из произвольной строки (только буквы/цифры/пробел/-_.)."""
    keep = "".join(c for c in (name or "") if c.isalnum() or c in " _-.").strip()
    return keep or "snapshot"


def list_weights_snapshots() -> list:
    """[{name, saved_at, tickers}] — по файлам в WEIGHTS_SNAPSHOTS_DIR."""
    out = []
    try:
        files = sorted(f for f in os.listdir(WEIGHTS_SNAPSHOTS_DIR) if f.endswith(".json"))
    except FileNotFoundError:
        return out
    for fn in files:
        try:
            with open(os.path.join(WEIGHTS_SNAPSHOTS_DIR, fn), encoding="utf-8") as f:
                d = json.load(f)
            out.append({
                "name": fn[:-5],
                "saved_at": d.get("saved_at"),
                "tickers": list((d.get("weights") or {}).keys()),
            })
        except Exception:
            pass
    return out


def save_weights_snapshot(name: str, weights: dict) -> dict:
    """Пишет обученные за прогон веса в отдельный файл — бота НЕ трогает."""
    if not (name or "").strip():
        return {"error": "пустое имя снимка"}
    if not weights:
        return {"error": "нет весов для сохранения (сначала прогон)"}
    os.makedirs(WEIGHTS_SNAPSHOTS_DIR, exist_ok=True)
    path = os.path.join(WEIGHTS_SNAPSHOTS_DIR, _safe_snap_name(name) + ".json")
    atomic_write_json(path, {"saved_at": time.time(), "weights": weights}, indent=2)
    return {"ok": True, "tickers": len(weights)}


def apply_weights_snapshot(name: str) -> dict:
    """Вливает веса снимка в боевой oi_weights.json (перезапись global+regimes
    по каждому figi). Делает бэкап oi_weights.json.bak. Влияет на бота —
    на фронте перед вызовом стоит подтверждение."""
    path = os.path.join(WEIGHTS_SNAPSHOTS_DIR, _safe_snap_name(name) + ".json")
    if not os.path.exists(path):
        return {"error": "снимок не найден"}
    with open(path, encoding="utf-8") as f:
        weights = (json.load(f) or {}).get("weights") or {}
    data = {}
    if os.path.exists(OI_WEIGHTS_FILE):
        with open(OI_WEIGHTS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        # бэкап перед перезаписью боевого файла
        atomic_write_json(OI_WEIGHTS_FILE + ".bak", data, indent=2)
    applied = 0
    for mw in weights.values():
        figi = mw.get("figi")
        if not figi:
            continue
        entry = data.setdefault(figi, {})
        for method, wd in (mw.get("global") or {}).items():
            # total==0 — метод в прогоне не обучался (молчал: микроструктура и
            # MULTI_TICKER в бэктесте без данных, редкие методы без голосов).
            # Затирать его ЖИВОЙ накопленный вес холодным стартом нельзя.
            if not wd.get("total"):
                continue
            entry[method] = {"weight": wd.get("weight", 0.3), "total": wd.get("total", 0),
                             "sum_quality": wd.get("sum_quality", 0.0)}
        if mw.get("regimes"):
            reg = entry.setdefault("__regimes__", {})
            for rg, methods in mw["regimes"].items():
                rgentry = reg.setdefault(rg, {})
                for method, wd in methods.items():
                    if not wd.get("total"):
                        continue
                    rgentry[method] = {"weight": wd.get("weight", 0.3), "total": wd.get("total", 0),
                                       "sum_quality": wd.get("sum_quality", 0.0)}
        applied += 1
    tmp = OI_WEIGHTS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, OI_WEIGHTS_FILE)
    return {"ok": True, "applied": applied, "backup": OI_WEIGHTS_FILE + ".bak"}


def save_overrides_payload(payload: dict) -> dict | None:
    """
    Возвращает None при успехе, {"error": ...} если запрошен переход в боевой
    режим (глобально или для конкретного тикера) без верного пароля
    из settings.ini [DASHBOARD_CONTROL] PASSWORD.
    """
    global_signal_only = payload.get("global_signal_only")
    partial_tp_enabled = payload.get("partial_tp_enabled")
    adaptive_exit_enabled = payload.get("adaptive_exit_enabled")
    orderbook_enabled = payload.get("orderbook_enabled")
    def _pct_or_none(key):
        v = payload.get(key)
        if v in (None, ""):
            return None
        try:
            f = float(v)
            return f if f > 0 else None
        except (TypeError, ValueError):
            return None
    daily_max_loss_pct = _pct_or_none("daily_max_loss_pct")
    weekly_max_loss_pct = _pct_or_none("weekly_max_loss_pct")
    monthly_max_loss_pct = _pct_or_none("monthly_max_loss_pct")
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

    existing = load_overrides()
    save_overrides({
        "global_signal_only": global_signal_only,
        "partial_tp_enabled": partial_tp_enabled,
        "adaptive_exit_enabled": adaptive_exit_enabled,
        "orderbook_enabled": orderbook_enabled,
        "daily_max_loss_pct": daily_max_loss_pct,
        "weekly_max_loss_pct": weekly_max_loss_pct,
        "monthly_max_loss_pct": monthly_max_loss_pct,
        "paused": existing.get("paused", False),
        "close_requests": existing.get("close_requests", []),
        "tickers": tickers_out,
    })
    return None


def _render_page() -> bytes:
    oi_tickers = load_oi_tickers()
    stocks = _strategy_settings_by_ticker()
    futures = _futures_settings_by_ticker()
    reload_running = _futures_reload_running.is_set()

    futures_by_cat: dict[str, list[str]] = {}
    for t in sorted(futures):
        cat = _futures_category_by_ticker.get(t, "Акции")
        futures_by_cat.setdefault(cat, []).append(t)

    stock_tickers = sorted(stocks)
    stocks_ru = [t for t in stock_tickers if t in _RU_STOCK_BASE_TICKERS]
    stocks_other = [t for t in stock_tickers if t not in _RU_STOCK_BASE_TICKERS]

    from html import escape as _he

    def _stock_chip_row(ts: list[str]) -> str:
        return '<div class="chip-row">' + "".join(
            f'<div class="chip active chip-stock" data-ticker="{_he(t)}" data-kind="stock" '
            f'title="{"OI" if t in oi_tickers else "settings.ini"}">{_he(t)}{"•" if t in oi_tickers else ""}</div>'
            for t in ts
        ) + '</div>'

    def _futures_chip_row(ts: list[str]) -> str:
        return '<div class="chip-row">' + "".join(
            f'<div class="chip active chip-fut" data-ticker="{_he(t)}" data-kind="futures" '
            f'title="{_he(_BASE_ASSET_LABEL.get(_futures_base_by_ticker.get(t, ""), _futures_base_by_ticker.get(t, t)))}'
            f' · GO {futures[t].margin_per_lot:.0f}₽">{_he(t)}</div>'
            for t in ts
        ) + '</div>'

    def _sub_section(pid: str, label: str, panel_html: str, open_: bool) -> str:
        safe_pid = _he(pid)
        js_pid = pid.replace("\\", "\\\\").replace("'", "\\'")
        return (
            f'<details class="chip-section cat-panel" data-panel="{safe_pid}"{" open" if open_ else ""}>'
            f'<summary><span class="chip-section-title">{_he(label)}</span>'
            f'<span class="cat-toc-toggle" title="вкл/выкл всю категорию" '
            f'onclick="event.preventDefault();event.stopPropagation();toggleCatPanel(\'{js_pid}\',this)">⊙</span></summary>'
            f'{panel_html}'
            f'</details>'
        )

    # Подкатегории внутри «Акции» — фиксированный порядок: РФ, затем другие.
    stock_subs = []
    if stocks_ru:
        stock_subs.append(_sub_section("stock-ru", f"РФ ({len(stocks_ru)})", _stock_chip_row(stocks_ru), True))
    if stocks_other:
        stock_subs.append(_sub_section("stock-other", f"Другие ({len(stocks_other)})", _stock_chip_row(stocks_other), False))

    # Подкатегории внутри «Фьючерсы» — фиксированный порядок: акции, сырьё,
    # металлы, индексы, валюта; неучтённые (если появится новый код) — следом.
    futures_subs = []
    ordered_cats = list(_FUTURES_CATEGORY_ORDER) + sorted(
        cat for cat in futures_by_cat if cat not in _FUTURES_CATEGORY_ORDER
    )
    for i, cat in enumerate(ordered_cats):
        ts = futures_by_cat.get(cat)
        if ts:
            futures_subs.append(_sub_section(f"fut-{cat}", f"{cat} ({len(ts)})", _futures_chip_row(ts), i == 0))

    # Два верхних раздела — Акции и Фьючерсы — каждый со своими подкатегориями внутри.
    cat_sections = ""
    if stock_subs:
        cat_sections += (
            f'<details class="chip-group" open><summary class="chip-group-title">'
            f'<span class="chip-section-title">♦️ Акции ({len(stocks)})</span></summary>'
            f'<div class="chip-group-body">{"".join(stock_subs)}</div></details>'
        )
    if futures_subs:
        cat_sections += (
            f'<details class="chip-group" open><summary class="chip-group-title">'
            f'<span class="chip-section-title">🔷 Фьючерсы ({len(futures)})</span></summary>'
            f'<div class="chip-group-body">{"".join(futures_subs)}</div></details>'
        )

    reload_hint = (
        '<span class="tk-btn-note">⏳ обновляется…</span>' if reload_running else ""
    )
    checkboxes = (
        f'<div class="tk-toolbar">'
        f'<button class="tk-btn" onclick="setAllChips(true)">✓ все</button>'
        f'<button class="tk-btn" onclick="setAllChips(false)">✗ снять</button>'
        f'<button class="tk-btn" onclick="reloadFutures()" title="Загрузить актуальные контракты из API (~10 мин)">🔄 контракты</button>'
        f'{reload_hint}'
        f'</div>'
        f'{cat_sections}'
    )
    rendered = (PAGE_HTML
                .replace("__TICKER_CHECKBOXES__", checkboxes)
                .replace("__BACKTEST_WORKERS__", str(BACKTEST_WORKERS))
                .replace("{{", "{").replace("}}", "}"))
    try:
        import tempfile, os as _os
        _debug = _os.path.join(_os.path.dirname(__file__), "data", "_debug_rendered.html")
        with open(_debug, "w", encoding="utf-8") as _f:
            _f.write(rendered)
    except Exception:
        pass
    return rendered.encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, payload: dict, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, exc: Exception, status: int = 500):
        """Ошибка запроса: пишем ПОЛНЫЙ трейсбек в серверный лог (раньше
        уходил только str(e) в браузер — где именно упало, было не видно) и
        отдаём краткий текст клиенту. Один центр — вместо логов в 47 местах."""
        logger.exception(f"dashboard {self.command} {self.path}: {exc}")
        self._send_json({"error": str(exc)}, status)

    def do_GET(self):
        if self.path == "/":
            try:
                body = _render_page()
            except Exception as _e:
                import traceback
                logger.exception(f"dashboard render / упал: {_e}")
                err_html = f"<pre>Ошибка рендеринга: {traceback.format_exc()}</pre>".encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(err_html)))
                self.end_headers()
                self.wfile.write(err_html)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/api/overrides":
            self._send_json(get_overrides_payload())
        elif self.path == "/api/auto_atr":
            self._send_json({"rows": get_auto_atr_snapshot()})
        elif self.path == "/api/history_coverage":
            self._send_json({"rows": get_history_coverage()})
        elif self.path == "/api/mfe_stats":
            self._send_json(get_mfe_mae_stats())
        elif self.path == "/api/method_catalog":
            # Эталонный список имён методов из Python (единый источник). JS
            # сверяет с ним свой _METHOD_CATALOG и ругается при расхождении —
            # чтобы фронтовый каталог не «разъезжался» с ALL_METHOD_NAMES молча.
            self._send_json({"names": list(ALL_METHOD_NAMES)})
        elif self.path == "/api/progress":
            self._send_json({"progress": dict(_get_progress_proxy())})
        elif self.path.startswith("/api/last_result"):
            from urllib.parse import urlparse, parse_qs
            kind = parse_qs(urlparse(self.path).query).get("kind", [""])[0]
            cached = _last_result.get(kind)
            self._send_json(cached if cached else {"missing": True})
        elif self.path.startswith("/api/diagnostics"):
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            ticker = qs.get("ticker", [""])[0]
            days = int(qs.get("days", ["30"])[0])
            try:
                self._send_json(get_diagnostics(ticker, days))
            except Exception as e:
                self._send_json({"ready": False, "error": str(e)})
        elif self.path.startswith("/api/trade_chart"):
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            ticker = qs.get("ticker", [""])[0]
            days = int(qs.get("days", ["90"])[0])
            atr_take = float(qs.get("atr_take", ["2.0"])[0])
            atr_stop = float(qs.get("atr_stop", ["1.0"])[0])
            try:
                self._send_json(get_trade_chart(ticker, days, atr_take, atr_stop))
            except Exception as e:
                self._send_error(e)
        elif self.path.startswith("/api/export_bar_scores"):
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            ticker = qs.get("ticker", [""])[0]
            days = int(qs.get("days", ["90"])[0])
            try:
                result = export_bar_scores_csv(ticker, days)
                if "error" in result:
                    self._send_json(result)
                else:
                    fname = f"{ticker}_bar_scores_{days}d.csv"
                    csv_bytes = result["csv"].encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/csv; charset=utf-8")
                    self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
                    self.send_header("Content-Length", str(len(csv_bytes)))
                    self.end_headers()
                    self.wfile.write(csv_bytes)
            except Exception as e:
                self._send_error(e)
        elif self.path.startswith("/api/export_trades_csv"):
            try:
                with _last_full_trades_lock:
                    debug_counts = {t: len(v) for t, v in _last_full_trades.items()}
                logger.info(f"export_trades_csv: _last_full_trades = {debug_counts}")
                csv_str = export_trades_csv_all()
                if not csv_str:
                    self._send_json({"error": f"нет данных — _last_full_trades={debug_counts}"})
                else:
                    csv_bytes = csv_str.encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/csv; charset=utf-8")
                    self.send_header("Content-Disposition", 'attachment; filename="trades_export.csv"')
                    self.send_header("Content-Length", str(len(csv_bytes)))
                    self.end_headers()
                    self.wfile.write(csv_bytes)
            except Exception as e:
                self._send_error(e)
        elif self.path == "/api/bot_status":
            self._send_json(get_bot_status())
        elif self.path == "/api/supervisor/status":
            self._send_json(supervisor_status())
        elif self.path.startswith("/api/supervisor/log"):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            n = int(qs.get("n", ["200"])[0])
            self._send_json(supervisor_log(n))
        elif self.path == "/api/universe":
            self._send_json(universe_get())
        elif self.path.startswith("/api/live_chart"):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            ticker = qs.get("ticker", [""])[0].upper()
            days = int(qs.get("days", ["7"])[0])
            self._send_json(get_live_chart(ticker, days))
        elif self.path == "/api/scorecard":
            self._send_json(get_scorecard_api())
        elif self.path == "/api/council_log":
            self._send_json(get_council_log())
        elif self.path == "/api/oi_backfill_status":
            self._send_json(get_oi_backfill_status())
        elif self.path == "/api/tickers_list":
            self._send_json(sorted(_all_settings_by_ticker().keys()))
        elif self.path == "/api/method_presets":
            self._send_json(get_method_presets())
        elif self.path == "/api/method_toggle_state":
            self._send_json(get_method_toggle_state())
        elif self.path.startswith("/api/system_backtest"):
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            days = int(qs.get("days", ["90"])[0])
            tk = qs.get("tickers", [""])[0]
            tickers = [t.strip() for t in tk.split(",") if t.strip()] or None
            try:
                self._send_json(run_system_backtest(days=days, tickers=tickers))
            except Exception as ex:
                import traceback
                logger.exception("system_backtest упал")
                self._send_json({"error": str(ex), "trace": traceback.format_exc()})
        elif self.path == "/api/method_calibration":
            self._send_json(get_method_calibration())
        elif self.path == "/api/moex_token_status":
            self._send_json(get_moex_token_status())
        elif self.path == "/api/weights_snapshots":
            self._send_json({"snapshots": list_weights_snapshots()})
        elif self.path.startswith("/api/bar_rules_load"):
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            ticker = qs.get("ticker", [""])[0].upper()
            try:
                from bar_rule_miner import load_rules, BAR_RULES_DIR
                import glob as _glob
                result = load_rules(ticker)
                if result is None:
                    self._send_json({"error": f"{ticker}: правила не найдены в {BAR_RULES_DIR}/"})
                else:
                    candidates = sorted(
                        _glob.glob(os.path.join(BAR_RULES_DIR, f"{ticker}_*.json")),
                        key=os.path.getmtime, reverse=True
                    )
                    path = candidates[0] if candidates else os.path.join(BAR_RULES_DIR, f"{ticker}.json")
                    self._send_json({"result": result, "path": path, "computed_at": result.get("computed_at","?")})
            except Exception as e:
                self._send_error(e)
        elif self.path.startswith("/api/bar_scores_list"):
            self._send_json(list_bar_scores_files())
        elif self.path.startswith("/api/bar_scores_download"):
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            fname = qs.get("file", [""])[0]
            # безопасность: только имя файла, без path traversal
            fname = os.path.basename(fname)
            fpath = os.path.join(BAR_SCORES_DIR, fname)
            if not fname.endswith(".csv") or not os.path.exists(fpath):
                self.send_error(404)
                return
            data = open(fpath, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif self.path.startswith("/api/bar_scores_batch"):
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            tickers = [t.strip() for t in qs.get("tickers", [""])[0].split(",") if t.strip()]
            days = int(qs.get("days", ["365"])[0])
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            def send_sse(event, data_dict):
                line = f"event: {event}\ndata: {json.dumps(data_dict, ensure_ascii=False)}\n\n"
                try:
                    self.wfile.write(line.encode("utf-8"))
                    self.wfile.flush()
                except Exception:
                    pass
            def on_progress(ticker, status, rows, error):
                send_sse("progress", {"ticker": ticker, "status": status, "rows": rows, "error": error})
            for t in tickers:
                send_sse("progress", {"ticker": t, "status": "running", "rows": 0, "error": None})
                export_bar_scores_batch([t], days, on_progress)
            send_sse("done", {"msg": "all done"})
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

        if self.path == "/api/client_error":
            # Ошибки браузерного JS (window.onerror/unhandledrejection) — чтобы
            # они не тонули молча в консоли, а падали в тот же серверный лог.
            logger.warning("client-JS %s @ %s: %s | %s",
                           payload.get("kind", "?"), payload.get("url", "?"),
                           str(payload.get("message", ""))[:500],
                           str(payload.get("extra", ""))[:500])
            self._send_json({"ok": True})
            return
        if self.path == "/api/bar_rules_apply":
            from_ticker = payload.get("from_ticker", "").upper()
            to_ticker   = payload.get("to_ticker", "").upper()
            target      = payload.get("target", "fwd_ret_3")
            try:
                from bar_rule_miner import load_rules, apply_rules_to_csv, save_rules
                src = load_rules(from_ticker)
                if src is None:
                    self._send_json({"error": f"{from_ticker}: правила не найдены, сначала запусти майнер"})
                    return
                result = apply_rules_to_csv(src, to_ticker, None, target)
                if result is None:
                    self._send_json({"error": f"{to_ticker}: нет CSV"})
                    return
                path = save_rules(f"{to_ticker}_from_{from_ticker}", result, None)
                n_global = len(result.get("global", {}).get("rules", []))
                self._send_json({"result": result, "path": path, "n_rules_global": n_global})
            except Exception as e:
                self._send_error(e)
        elif self.path == "/api/bar_rules_mine":
            ticker       = payload.get("ticker", "").upper()
            target       = payload.get("target", "fwd_ret_3")
            max_depth    = int(payload.get("max_depth", 4))
            event_filter = payload.get("event_filter", "all")
            try:
                from bar_rule_miner import mine_ticker, save_rules
                result = mine_ticker(ticker, None, max_depth, target, event_filter)
                if result is None:
                    self._send_json({"error": f"{ticker}: нет CSV или пустой результат"})
                else:
                    path = save_rules(ticker, result, None)
                    n_global = len(result.get("global", {}).get("rules", []))
                    self._send_json({"result": result, "path": path, "n_rules_global": n_global})
            except Exception as e:
                self._send_error(e)
        elif self.path == "/api/backtest_one":
            ticker = payload.get("ticker", "")
            days = int(payload.get("days", 30))
            offset_days = int(payload.get("offset_days", 0))
            atr_take_ks = [float(x) for x in str(payload.get("atr_take", "2,3,4")).split(",") if x.strip()]
            atr_stop_ks = [float(x) for x in str(payload.get("atr_stop", "1,1.5,2")).split(",") if x.strip()]
            tariff = payload.get("tariff") or None
            rows, hist, r_trades = run_backtest_one(ticker, days, atr_take_ks, atr_stop_ks, tariff=tariff, offset_days=offset_days)
            if hist is not None:
                _last_backtest_history_data[ticker] = hist
            with _last_full_trades_lock:
                _last_full_trades.update(r_trades)
            self._send_json({"rows": rows})
        elif self.path == "/api/backtest":
            tickers = payload.get("tickers", [])
            days = int(payload.get("days", 30))
            offset_days = int(payload.get("offset_days", 0))
            atr_take_ks = [float(x) for x in str(payload.get("atr_take", "2,3,4")).split(",") if x.strip()]
            atr_stop_ks = [float(x) for x in str(payload.get("atr_stop", "1,1.5,2")).split(",") if x.strip()]
            tariff = payload.get("tariff") or None
            rows, hist_by_ticker = run_backtest(tickers, days, atr_take_ks, atr_stop_ks, tariff=tariff, offset_days=offset_days)
            _last_backtest_history_data.update(hist_by_ticker)
            _last_result["backtest"] = {"rows": rows}
            self._send_json({"rows": rows})
        elif self.path == "/api/backtest_stream":
            # Стриминг бэктеста: каждый готовый тикер сразу отправляется клиенту
            # без ожидания остальных. Формат — Server-Sent Events (text/event-stream).
            tickers = payload.get("tickers", [])
            days = int(payload.get("days", 30))
            offset_days = int(payload.get("offset_days", 0))
            atr_take_ks = [float(x) for x in str(payload.get("atr_take", "2,3,4")).split(",") if x.strip()]
            atr_stop_ks = [float(x) for x in str(payload.get("atr_stop", "1,1.5,2")).split(",") if x.strip()]
            tariff = payload.get("tariff") or None
            adaptive_narrative = bool(payload.get("adaptive_narrative", False))
            adaptive_lasso = bool(payload.get("adaptive_lasso", False))
            block_ranging = bool(payload.get("block_ranging", False))
            disabled_methods = payload.get("disabled_methods") or []
            inverted_methods = payload.get("inverted_methods") or []

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()

            def _sse(obj: dict) -> None:
                line = "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"
                self.wfile.write(line.encode("utf-8"))
                self.wfile.flush()

            _cancel_event.clear()
            progress = _get_progress_proxy()
            for t in tickers:
                _set_progress(progress, t, "в очереди")

            all_rows: list[dict] = []
            if not tickers:
                try:
                    _sse({"done": True})
                except Exception:
                    pass
                return

            # Свежий ОИ из воркера (D1) в data/oi_daily.json до старта пула —
            # подпроцессы дальше читают уже готовый файл.
            ensure_oi_synced(tickers, days=days, offset_days=offset_days)

            pool = ProcessPoolExecutor(max_workers=min(BACKTEST_WORKERS, len(tickers)))
            _register_pool(pool)
            try:
                fs = {
                    pool.submit(run_backtest_one, t, days, atr_take_ks, atr_stop_ks,
                                tariff=tariff, progress=progress, offset_days=offset_days,
                                adaptive_narrative=adaptive_narrative, adaptive_lasso=adaptive_lasso,
                                block_ranging=block_ranging,
                                disabled_methods=disabled_methods or None,
                                inverted_methods=inverted_methods or None): t
                    for t in tickers
                }
                for fut in as_completed(fs):
                    if _cancel_event.is_set():
                        break
                    t = fs[fut]
                    try:
                        rows, hist, r_trades = fut.result()
                        if hist is not None:
                            _last_backtest_history_data[t] = hist
                        with _last_full_trades_lock:
                            _last_full_trades.update(r_trades)
                        n_tr = sum(len(v) for v in r_trades.values())
                        logger.info(f"backtest_stream {t}: получено {n_tr} трейдов в r_trades")
                    except Exception as ex:
                        rows = [{"ticker": t, "mode": "ошибка", "error": str(ex)}]
                        _set_progress(progress, t, "ошибка")
                    all_rows.extend(rows)
                    try:
                        _sse({"ticker": t, "rows": rows})
                    except Exception:
                        pass  # клиент отвалился — НЕ break, чтобы r_trades остальных тикеров дошли
            finally:
                _unregister_pool(pool)
                # wait=True: дожидаемся, чтобы воркер-процессы реально
                # завершились (отдали CPU/память) ДО конца ответа — иначе
                # они продолжают доедать ресурсы ещё несколько секунд после
                # большого прогона, и следующий запрос (например "сохранить
                # историю", если что-то не закэшировано и придётся
                # пересчитывать) ловит ERR_CONNECTION_RESET/REFUSED, потому
                # что accept-потоку сервера не хватает CPU.
                pool.shutdown(wait=True, cancel_futures=True)

            if _cancel_event.is_set():
                _mark_unfinished_cancelled(progress, tickers)

            _last_result["backtest"] = {"rows": all_rows}
            # Автосохранение в data/history.json сразу здесь, в этом же
            # запросе — без отдельного клика "сохранить историю", который
            # уязвим к перегрузке сервера сразу после большого прогона
            # (ERR_CONNECTION_RESET/REFUSED). Пул уже остановлен (wait=True
            # выше), CPU свободен — пишем прямо сейчас, пока процесс жив.
            saved_days, saved_trades = 0, 0
            try:
                saved_days, saved_trades = _persist_history_dicts(
                    {t: _last_backtest_history_data[t] for t in tickers if t in _last_backtest_history_data}
                )
            except Exception as ex:
                logger.warning(f"backtest_stream: автосохранение истории не удалось: {ex}")
            try:
                _sse({"done": True, "auto_saved_days": saved_days, "auto_saved_trades": saved_trades})
            except Exception:
                pass
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
            _last_result["portfolio_sim"] = result
            self._send_json(result)
        elif self.path == "/api/import_oi":
            oi_tickers = payload.get("tickers", [])
            signal_log = payload.get("signalLog", [])
            n = merge_oi_tickers(oi_tickers, signal_log)
            self._send_json({"imported": n, "tickers": sorted(_all_settings_by_ticker().keys())})
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
        elif self.path == "/api/oi_ticker_remove":
            self._send_json(delete_oi_ticker(payload.get("ticker", "")))
        elif self.path == "/api/oi_tickers_prune_stale":
            self._send_json(prune_stale_oi_tickers())
        elif self.path == "/api/oi_tickers_prune_failed":
            # Клиент может передать свой снимок статусов — иначе берём _progress.
            snap = payload.get("statuses") if isinstance(payload.get("statuses"), dict) else None
            self._send_json(prune_failed_oi_tickers(snap))
        elif self.path == "/api/reload_futures":
            started = _start_futures_reload_bg()
            running = _futures_reload_running.is_set()
            self._send_json({"started": started, "running": running})
        elif self.path == "/api/moex_token_save":
            self._send_json(save_moex_token(payload.get("token", "")))
        elif self.path == "/api/method_presets_save":
            err = save_method_preset(payload.get("name"), payload.get("disabled"), payload.get("inverted"))
            self._send_json(err if err else {"ok": True})
        elif self.path == "/api/method_presets_delete":
            delete_method_preset(payload.get("name", ""))
            self._send_json({"ok": True})
        elif self.path == "/api/method_toggle_state_save":
            save_method_toggle_state(payload.get("disabled") or [], payload.get("inverted") or [])
            self._send_json({"ok": True})
        elif self.path == "/api/weights_snapshot_save":
            self._send_json(save_weights_snapshot(payload.get("name"), payload.get("weights") or {}))
        elif self.path == "/api/weights_snapshot_apply":
            self._send_json(apply_weights_snapshot(payload.get("name", "")))
        elif self.path == "/api/equity_analysis":
            tickers = payload.get("tickers", [])
            days = int(payload.get("days", 60))
            account = float(payload.get("account", 100000))
            risk_pct = float(payload.get("risk_pct", 1))
            if not tickers:
                self._send_json({"error": "нет тикеров"}, status=400)
            else:
                sim = run_portfolio_sim(tickers, days, account, risk_pct, mode="atr")
                analytics = compute_equity_analytics(sim.get("trades", []), account)
                sim["analytics"] = analytics
                self._send_json(sim)
        elif self.path == "/api/save_method_weights":
            # payload: {ticker: {method: multiplier}}
            path = os.path.join("data", "ticker_method_weights.json")
            os.makedirs("data", exist_ok=True)
            # мёрджим с существующим файлом (не затираем тикеры, которых нет в payload)
            existing = {}
            if os.path.exists(path):
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        existing = json.load(f)
                except Exception:
                    pass
            existing.update(payload)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(existing, f, ensure_ascii=False, indent=2)
            os.replace(tmp, path)
            self._send_json({"ok": True, "tickers": len(payload)})
        elif self.path == "/api/reset_weights":
            # Сброс oi_weights.json: все Hedge-веса методов → 0.30 (консервативный старт).
            # Не удаляет файл целиком — сохраняет структуру (tickers/regimes),
            # только обнуляет накопленные веса. IC-prior'ы не трогает.
            weights_path = "oi_weights.json"
            reset_count = 0
            try:
                data = {}
                if os.path.exists(weights_path):
                    with open(weights_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                for figi_key, figi_data in data.items():
                    if not isinstance(figi_data, dict):
                        continue
                    for mname, mdata in figi_data.items():
                        if mname == "__regimes__":
                            for rdata in mdata.values():
                                for rm in rdata.values():
                                    if isinstance(rm, dict) and "weight" in rm:
                                        rm["weight"] = 0.30
                                        rm["total"] = 0
                                        rm["sum_quality"] = 0.0
                                        reset_count += 1
                        elif isinstance(mdata, dict) and "weight" in mdata:
                            mdata["weight"] = 0.30
                            mdata["total"] = 0
                            mdata["sum_quality"] = 0.0
                            reset_count += 1
                tmp = weights_path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                os.replace(tmp, weights_path)
                self._send_json({"ok": True, "reset_count": reset_count, "tickers": len(data)})
            except Exception as e:
                self._send_json({"error": str(e)}, status=500)
        elif self.path == "/api/save_backtest_history":
            tickers = payload.get("tickers", [])
            days = int(payload.get("days", 90))
            offset_days = int(payload.get("offset_days", 0))
            if not tickers:
                self._send_json({"error": "нет тикеров"}, status=400)
            else:
                result = save_cached_backtest_history(tickers, days, offset_days)
                self._send_json(result)
        elif self.path == "/api/run_calibration":
            if payload.get("use_all_history"):
                # Калибровка по ВСЕМУ, что уже лежит в data/history.json, а не
                # только по тикерам активных чипов на странице (если прогон
                # сохранялся раньше — выбор чипов мог не совпасть, и калибровка
                # просто не находила сделки). days берём по самому старому
                # покрытому тикеру, чтобы окно гарантированно захватило все
                # сохранённые сделки у всех тикеров.
                coverage = get_history_coverage()
                tickers = [row["ticker"] for row in coverage]
                today = datetime.datetime.now(datetime.timezone.utc).date()
                days = 90
                for row in coverage:
                    span = (today - datetime.datetime.strptime(row["from"], "%Y-%m-%d").date()).days + 1
                    days = max(days, span)
            else:
                tickers = payload.get("tickers", [])
                days = int(payload.get("days", 90))
            if not tickers:
                self._send_json({"error": "нет тикеров"}, status=400)
            else:
                progress = _get_progress_proxy()
                progress["_calibration"] = {
                    "step": 0, "total": 3 * len(tickers), "stage": "narrative", "ticker": "", "ts": time.time(),
                }
                result = run_calibration_pipeline(tickers, days, progress=progress)
                result["tickers_used"] = tickers
                result["days_used"] = days
                self._send_json(result)
        elif self.path == "/api/cancel":
            was_running = request_cancel()
            self._send_json({"cancelled": was_running})
        elif self.path == "/api/bot_control":
            action = payload.get("action", "")
            ticker = payload.get("ticker", "")
            self._send_json(bot_control_action(action, ticker))
        elif self.path == "/api/supervisor/start":
            self._send_json(supervisor_start(bool(payload.get("sandbox", True))))
        elif self.path == "/api/supervisor/stop":
            self._send_json(supervisor_stop())
        elif self.path == "/api/supervisor/force_kill":
            self._send_json(supervisor_force_kill())
        elif self.path == "/api/universe/compute":
            self._send_json(universe_compute(payload.get("candidates")))
        elif self.path == "/api/universe/save":
            self._send_json(universe_save(payload))
        elif self.path == "/api/oi_backfill":
            months = int(payload.get("months", 12))
            raw_t = payload.get("tickers") or None
            tickers = [t.strip().upper() for t in raw_t.split(",") if t.strip()] if isinstance(raw_t, str) and raw_t.strip() else (raw_t if isinstance(raw_t, list) else None)
            self._send_json(run_oi_backfill(months, tickers))
        elif self.path == "/api/oi_sync_worker":
            raw_t = payload.get("tickers") or None
            tickers = [t.strip().upper() for t in raw_t.split(",") if t.strip()] if isinstance(raw_t, str) and raw_t.strip() else (raw_t if isinstance(raw_t, list) else None)
            self._send_json(oi_sync_from_worker(tickers))
        elif self.path == "/api/oi_worker_catalog":
            raw_t = payload.get("tickers") or None
            tickers = [t.strip().upper() for t in raw_t.split(",") if t.strip()] if isinstance(raw_t, str) and raw_t.strip() else (raw_t if isinstance(raw_t, list) else None)
            self._send_json(oi_worker_catalog(tickers))
        elif self.path == "/api/council_ask":
            self._send_json(council_ask_sync(payload.get("ticker","").upper(), payload.get("question",""), payload.get("direction","LONG").upper()))
        elif self.path == "/api/bot_adopt":
            try:
                ticker = payload.get("ticker", "").strip()
                direction = payload.get("direction", "LONG").strip().upper()
                take = float(payload["take"])
                stop = float(payload["stop"])
                entry = float(payload["entry"]) if payload.get("entry") not in (None, "") else None
                if not ticker or direction not in ("LONG", "SHORT"):
                    self._send_json({"error": "нужны ticker и direction (LONG/SHORT)"}, 400)
                else:
                    self._send_json(bot_adopt_position(ticker, direction, take, stop, entry))
            except (KeyError, ValueError) as e:
                self._send_json({"error": f"нужны take и stop: {e}"}, 400)
        elif self.path == "/api/bot_move_stop":
            try:
                ticker = payload.get("ticker", "").strip()
                new_stop = float(payload["new_stop"])
                new_take = float(payload["new_take"]) if payload.get("new_take") not in (None, "") else None
                if not ticker:
                    self._send_json({"error": "нужен ticker"}, 400)
                else:
                    self._send_json(bot_move_stop(ticker, new_stop, new_take))
            except (KeyError, ValueError) as e:
                self._send_json({"error": f"нужен new_stop: {e}"}, 400)
        else:
            self.send_error(404)

    def log_message(self, fmt, *args):
        logger.info("%s - %s", self.address_string(), fmt % args)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    # daemon_threads=True — без этого Ctrl+C обрывает только accept-loop,
    # а поток с долгим расчётом (бэктест/портфель) продолжает жить и держит
    # процесс/терминал, не давая ввести новую команду.
    server.daemon_threads = True
    # Дефолтный request_queue_size=5 (socketserver) — под нагрузкой, когда
    # воркеры бэктеста забивают все ядра, accept-loop не успевает быстро
    # разгребать очередь TCP-подключений (опрос /api/progress раз в 800мс +
    # сам долгий POST). Очередь переполняется, ОС отвечает на новые
    # подключения RST/refused, и клик "СТОП" падает с "Failed to fetch"
    # ещё ДО того как запрос вообще дошёл до Python. Увеличиваем запас.
    server.request_queue_size = 64
    print(f"Дашборд: http://127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
