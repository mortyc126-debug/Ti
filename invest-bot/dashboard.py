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

import datetime
import multiprocessing
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
from archive import ArchiveStore
from calibration import PercentileCalibrator
from candle_archive import get_candles_cached
from configuration.configuration import ProgramConfiguration
from configuration.settings import StrategySettings
from db_api_client import DbApiClient
from history import BacktestHistoryStore, HistoryStore
from invest_api.services.instruments_service import InstrumentService
from invest_api.services.market_data_service import MarketDataService
from mega_alerts import MegaAlertsService
from runtime_overrides import load_overrides, save_overrides
from trade_system.issuer_filter import issuer_key, select_top_tickers
from trade_system.strategies.oi_composite_strategy import (
    AUTO_ATR_MIN_TRADES, AUTO_ATR_SCALE_EXPS, AUTO_ATR_STOP_KS, AUTO_ATR_TAKE_KS,
)
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


def _wire_history_returning(strategy) -> BacktestHistoryStore:
    """Как _wire_history, но возвращает store чтобы после прогона можно было
    забрать накопленные сделки и сохранить их в реальный HistoryStore."""
    store = BacktestHistoryStore()
    if hasattr(strategy, "set_history"):
        strategy.set_history(store, PercentileCalibrator())
    return store


def _save_backtest_history_one(ticker: str, days: int, offset_days: int = 0) -> tuple[str, dict | None, int, str | None]:
    """Считает накопленную историю одного тикера (для save_backtest_history).
    Выделено в отдельную функцию, чтобы гонять тикеры параллельно по
    процессам — тот же CPU-bound скан, что и в run_backtest_one."""
    by_ticker = _all_settings_by_ticker()
    settings = by_ticker.get(ticker)
    if settings is None:
        return ticker, None, 0, f"{ticker}: нет в settings"
    try:
        strategy = StrategyFactory.new_factory(settings.name, settings)
        bt_store = _wire_history_returning(strategy)
        candles = get_candles_cached(ticker, settings.figi, days, _market_data, _db,
                                     candle_interval_min=settings.candle_interval_min,
                                     offset_days=offset_days)
        if not candles:
            return ticker, None, 0, f"{ticker}: нет свечей"
        strategy.backtest_barriers(candles)
        hist = bt_store._data.get(ticker, {})
        n_trades = sum(len(day.get("trades", [])) for day in hist.values())
        return ticker, hist, n_trades, None
    except Exception as ex:
        return ticker, None, 0, f"{ticker}: {ex}"


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

    if len(tickers) <= 1:
        results = [_save_backtest_history_one(t, days, offset_days) for t in tickers]
    else:
        results = []
        pool = ProcessPoolExecutor(max_workers=min(BACKTEST_WORKERS, len(tickers)))
        _register_pool(pool)
        try:
            futures = {pool.submit(_save_backtest_history_one, t, days, offset_days): t for t in tickers}
            for fut in as_completed(futures):
                ticker = futures[fut]
                try:
                    results.append(fut.result())
                except Exception as ex:
                    results.append((ticker, None, 0, f"{ticker}: {ex}"))
        finally:
            _unregister_pool(pool)
            pool.shutdown(wait=False, cancel_futures=True)

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


def run_calibration_pipeline(tickers: list[str], days: int) -> dict:
    """Шаги 2-4 run_pipeline.py (narrative-пороги + lasso + rule_miner) на
    уже сохранённой data/history.json — без бэктеста (см. save_backtest_history
    для шага 1). Дёргается из дашборда кнопкой "🎯 калибровать", чтобы не лезть
    в консоль каждый раз после "💾 сохранить историю"."""
    # Импорт внутри функции, не на уровне модуля: calibrate_narrative/
    # lasso_calibration/rule_miner сами импортируют из dashboard
    # (_strategy_settings_by_ticker, _db, _market_data, _wire_history) —
    # импорт на верхнем уровне даёт циклический импорт при старте dashboard.py.
    import calibrate_narrative
    import lasso_calibration
    import rule_miner

    errors: list[str] = []
    by_ticker = _strategy_settings_by_ticker()

    existing_thresh = calibrate_narrative._load_existing()
    n_pairs_before = sum(len(v) for v in existing_thresh.values())
    for ticker in tickers:
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
        try:
            result = rule_miner._mine_one(ticker, days, rule_miner._DEFAULT_MAX_DEPTH)
        except Exception as ex:
            errors.append(f"rule_miner/{ticker}: {ex}")
            continue
        if result:
            existing_rules[ticker] = result
            rule_tickers += 1
    rule_miner._save(existing_rules)

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
    try:
        pool.shutdown(wait=False, cancel_futures=True)
    except Exception:
        pass
    for p in list(getattr(pool, "_processes", {}).values()):
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
        with open(FUTURES_DISK_CACHE, "w", encoding="utf-8") as f:
            json.dump({"saved_at": time.time(), "contracts": data}, f, ensure_ascii=False)
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


def _build_strategy_settings(contracts: dict[str, dict]) -> dict[str, StrategySettings]:
    """Строит dict[ticker → StrategySettings] из сохранённых данных контрактов."""
    stock_settings = {s.ticker: s for s in _config.trade_strategy_settings}
    ma = _config.mega_alerts_settings
    result: dict[str, StrategySettings] = {}
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

    signals = strategy.backtest_scan_signals(candles)
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
        + ["fwd_ret_3", "fwd_ret_6", "fwd_ret_12"]
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
        }
        for sn in score_names:
            record[sn] = round(row["scores"].get(sn, 0.0), 4)
        writer.writerow(record)

    return {"csv": buf.getvalue(), "rows": len(rows), "ticker": ticker}


def get_diagnostics(ticker: str, days: int = 30) -> dict:
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


def _method_stats_from_trades(trades: list[dict]) -> dict:
    """Per-method agree/disagree attribution из списка сделок.
    Каждая сделка должна иметь method_scores (dict метод→скор) и direction/win."""
    tally: dict[str, dict] = {}
    for t in trades:
        dir_sign = 1 if t["direction"] == "LONG" else -1
        for mname, m_sc in t.get("method_scores", {}).items():
            if abs(m_sc) < 0.02:
                continue
            e = tally.setdefault(mname, {"agree_n": 0, "agree_win": 0, "disagree_n": 0, "disagree_win": 0})
            if (m_sc > 0) == (dir_sign > 0):
                e["agree_n"] += 1
                e["agree_win"] += int(t["win"])
            else:
                e["disagree_n"] += 1
                e["disagree_win"] += int(t["win"])
    return {
        mname: {
            "agree_n": e["agree_n"],
            "agree_win_rate": e["agree_win"] / e["agree_n"] if e["agree_n"] else None,
            "disagree_n": e["disagree_n"],
            "disagree_win_rate": e["disagree_win"] / e["disagree_n"] if e["disagree_n"] else None,
        }
        for mname, e in tally.items()
    }


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
ATR_MIN_EDGE_SEM = 1.0          # ATR-кандидат должен превосходить fixed минимум на N своих SEM,
                                # иначе остаёмся на текущих параметрах (не дёргаем из-за шума)


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

    strategy_settings = by_ticker.get(ticker)
    if strategy_settings is None:
        rows.append({"ticker": ticker, "mode": "ошибка", "error": "нет в settings.ini"})
        _set_progress(progress, ticker, "ошибка")
        return rows

    t0 = time.monotonic()
    logger.info(f"{ticker}: получаю историю свечей ({days} дн.)...")
    _set_progress(progress, ticker, "загрузка свечей")
    try:
        strategy = StrategyFactory.new_factory(strategy_settings.name, strategy_settings)
        bt_store = _wire_history_returning(strategy)
        if strategy is None or not hasattr(strategy, "backtest_barriers"):
            rows.append({"ticker": ticker, "mode": "пропуск",
                         "error": "стратегия не поддерживает backtest_barriers"})
            _set_progress(progress, ticker, "пропуск")
            return rows, None

        try:
            candles = get_candles_cached(ticker, strategy_settings.figi, days, _market_data, _db,
                                         candle_interval_min=strategy_settings.candle_interval_min,
                                         offset_days=offset_days)
        except RequestError as ex:
            rows.append({"ticker": ticker, "mode": "ошибка API", "error": str(ex.details)})
            _set_progress(progress, ticker, "ошибка API")
            return rows, None
        except Exception as ex:
            rows.append({"ticker": ticker, "mode": "нет истории", "error": str(ex)})
            _set_progress(progress, ticker, "нет истории")
            return rows, None

        if not candles:
            rows.append({"ticker": ticker, "mode": "нет истории", "error": ""})
            _set_progress(progress, ticker, "нет истории")
            return rows, None

        logger.info(f"{ticker}: {len(candles)} свечей за {time.monotonic() - t0:.1f}с, считаю сигналы "
                    f"(может занять минуту-две — внутри Hawkes-MLE на каждый бар)...")
        _set_progress(progress, ticker, f"скан сигналов ({len(candles)} свечей)")
        s = strategy_settings.settings
        long_take = Decimal(s.get("LONG_TAKE", "1.015"))
        long_stop = Decimal(s.get("LONG_STOP", "0.985"))

        t1 = time.monotonic()
        signals = strategy.backtest_scan_signals(candles)
        logger.info(f"{ticker}: {len(signals)} сигналов, скан занял {time.monotonic() - t1:.1f}с")

        fixed = strategy.backtest_barriers(signals=signals, take_mult=long_take, stop_mult=long_stop,
                                            return_trades=True, tariff=tariff)
        fixed_trades = fixed.pop("trades", [])
        fixed_pct = fixed.get("expectancy_pct", 0.0)
        rows.append({"ticker": ticker, "mode": "fixed", "what_if": _what_if_from_trades(fixed_trades), **fixed})

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
                    split = int(len(past_signals) * 0.6)
                    eval_signals = past_signals[split:] if len(past_signals) - split >= AUTO_ATR_MIN_TRADES else past_signals
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
                    "method_stats": _method_stats_from_trades(wf_trades),
                }
                rows.append({"ticker": ticker, "mode": "ATR walk-forward",
                             "what_if": _what_if_from_trades(wf_trades), **wf_row})

    except Exception:
        tb = traceback.format_exc()
        context = (f"dashboard run_backtest: ticker={ticker}, days={days}, "
                   f"atr_take={atr_take_ks}, atr_stop={atr_stop_ks}")
        advice = bug_council.analyze_bug(tb, context)
        logger.error(f"run_backtest {ticker}:\n{tb}")
        rows.append({"ticker": ticker, "mode": "ошибка", "error": tb.strip().splitlines()[-1],
                     "traceback": tb, "advice": advice})
        _set_progress(progress, ticker, "ошибка")
        return rows, None

    _set_progress(progress, ticker, "готово")
    # .get(ticker, {}) а не None: если у тикера слишком мало свечей для скана
    # (ничего не записалось в bt_store), это всё равно ЗАВЕРШЁННЫЙ прогон без
    # данных — а не "не пытались". {} != None дальше отличает это от реально
    # отсутствующего кэша (см. save_cached_backtest_history) — иначе такие
    # тикеры заново и заново уходили в пересчёт при каждом "сохранить историю".
    return rows, bt_store._data.get(ticker, {})


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

    if len(tickers) <= 1:
        rows: list[dict] = []
        hist_by_ticker: dict[str, dict] = {}
        for ticker in tickers:
            if _cancel_event.is_set():
                break
            r_rows, r_hist = run_backtest_one(ticker, days, atr_take_ks, atr_stop_ks, tariff=tariff, progress=progress, offset_days=offset_days)
            rows.extend(r_rows)
            if r_hist is not None:
                hist_by_ticker[ticker] = r_hist
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
                r_rows, r_hist = fut.result()
                by_ticker_rows[ticker] = r_rows
                if r_hist is not None:
                    hist_by_ticker[ticker] = r_hist
            except Exception:
                pass  # воркер мог быть убит через /api/cancel — это ожидаемо
    finally:
        _unregister_pool(pool)
        pool.shutdown(wait=False, cancel_futures=True)

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

        _set_progress(progress, ticker, f"скан сигналов ({len(candles)} свечей)")
        signals = strategy.backtest_scan_signals(candles)
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
            pool.shutdown(wait=False, cancel_futures=True)

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
.chips{{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px;}}
.chip{{display:inline-flex;align-items:center;gap:1px;padding:5px 12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:999px;cursor:pointer;transition:all .15s;font-size:11px;font-weight:600;color:var(--txt);white-space:nowrap;}}
.chip:hover{{border-color:rgba(255,0,128,.25);}}
.chip.active{{background:linear-gradient(180deg,rgba(255,0,128,.18),rgba(255,0,128,.08));border-color:rgba(255,0,128,.45);color:var(--accent);}}
.chip-fut{{border-color:rgba(80,140,255,.25);}}
.chip-fut.active{{background:linear-gradient(180deg,rgba(80,140,255,.2),rgba(80,140,255,.08));border-color:rgba(80,140,255,.6);color:#7eb8f7;}}
.chip-fut:hover{{border-color:rgba(80,140,255,.5);}}
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
</div>

<nav class="tab-nav">
  <button class="tab-btn active" onclick="showTab('sim')">СИМУЛЯЦИЯ</button>
  <button class="tab-btn" onclick="showTab('analytics')">📈 АНАЛИТИКА</button>
  <button class="tab-btn" onclick="showTab('diag')">ДИАГНОСТИКА</button>
  <button class="tab-btn" onclick="showTab('live')">БОТ (LIVE)</button>
</nav>

<!-- ══════════════════════ TAB: СИМУЛЯЦИЯ ══════════════════════ -->
<div class="tab-pane active" id="tab-sim">

<div class="panel">
  <div class="sec-lg">Настройки симуляции</div>
  <div style="font-size:11px;color:var(--txt3);margin-bottom:8px;">
    🔷 Фьючерсы — из [FUTURES_TRADING] (авто). 📈 Акции — settings.ini + OI.
    <input type="file" id="oiFile" accept="application/json" style="display:none" onchange="importOiFile(event)">
    <button class="btn-pill btn-sm" onclick="document.getElementById('oiFile').click()">↓ Импорт из OI</button>
    <button class="btn-pill btn-sm" onclick="fetchMegaAlerts()">🔥 Аномалии MOEX</button>
    <span id="oi_status"></span>
  </div>
  <div id="tickers" style="display:flex;flex-wrap:wrap;gap:4px;align-content:flex-start;">__TICKER_CHECKBOXES__</div>
  <!-- 150+ дней нужно для "разогрева" M1/M2/M3: regime_method_performance
       (effWR кластеров) требует 90 дней накопленной истории скоров, иначе
       _MIN_OBS не набирается и M1=M2=M3 (см. cluster_models.py) — бэктест
       короче 90 дней молчит почти весь прогон. -->
  <label>Дней истории <input type="number" class="inp mid" id="days" value="150" min="1" max="240"></label>
  <label title="Сдвиг конца периода назад от сегодня, в днях. 0 = период кончается сегодня. Чтобы добрать более старый период без повторного прогона уже посчитанного — например, прогнала days=150 offset=0 (последние 150 дней), затем days=150 offset=150 (предыдущие 150, т.е. 150-300 дней назад).">Сдвиг начала, дн. <input type="number" class="inp mid" id="offset_days" value="0" min="0" max="2000"></label>
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
</div>

<div class="panel">
  <div class="sec-lg">Бэктест по тикерам</div>
  <button class="btn-pill" onclick="runBacktest()">▶ ЗАПУСТИТЬ БЭКТЕСТ</button>
  <button class="btn-pill" style="background:var(--neg);" onclick="cancelRun()">⏹ СТОП</button>
  <button class="btn-pill btn-sm" style="color:#aaa" onclick="saveBacktestHistory()" title="Сохранить сделки бэктеста в history.json для калибровки lasso">💾 сохранить историю</button>
  <button class="btn-pill btn-sm" style="color:#aaa" onclick="runCalibration()" title="Калибровка порогов narrative.py + lasso_calibration + rule_miner по уже сохранённой history.json">🎯 калибровать (narrative+lasso+rules)</button>
  <span id="status"></span>
  <label style="margin-left:8px;font-size:11px;color:var(--txt3);">
    <input type="checkbox" id="hide_zero" onchange="renderResultsTable()"> скрыть тикеры без сделок
  </label>
  <div id="status_detail" style="font-size:11px;color:var(--txt3);margin-top:6px;"></div>
  <table class="scen-table" id="results"></table>
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
  <button class="btn-pill" style="background:var(--neg);" onclick="cancelRun()">⏹ СТОП</button>
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
    <button class="btn-pill" style="background:var(--accent2,#2a4a2a);" onclick="exportBarScores()" title="Скачать CSV со всеми method_scores по каждому бару — для AI-анализа">📥 CSV для AI</button>
    <span id="tc_status" style="font-size:11px;color:var(--txt3);"></span>
  </div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;font-size:11px;color:var(--txt3);">
    <span>🔍 колесо/пинч — масштаб &nbsp;|&nbsp; перетащи — панорама &nbsp;|&nbsp; Shift+drag — выделить область</span>
    <button class="btn-pill" style="padding:3px 10px;font-size:10px;" onclick="tcZoomAll()">Всё</button>
    <button class="btn-pill" style="padding:3px 10px;font-size:10px;" onclick="tcZoomLast(30)">30д</button>
    <button class="btn-pill" style="padding:3px 10px;font-size:10px;" onclick="tcZoomLast(14)">14д</button>
    <button class="btn-pill" style="padding:3px 10px;font-size:10px;" onclick="tcZoomLast(7)">7д</button>
    <span style="margin-left:8px;">Вид:</span>
    <button class="btn-pill" id="tc_mode_candle" style="padding:3px 10px;font-size:10px;background:var(--mem);" onclick="tcSetMode('candle')">Свечи</button>
    <button class="btn-pill" id="tc_mode_line"   style="padding:3px 10px;font-size:10px;" onclick="tcSetMode('line')">Линия</button>
  </div>
  <canvas id="tc_canvas" style="width:100%;height:480px;display:block;cursor:crosshair;background:var(--panel);border-radius:10px;border:1px solid var(--border);"></canvas>
  <div id="tc_sel_info" style="font-size:12px;color:var(--txt2);margin-top:6px;min-height:24px;padding:4px 8px;background:var(--card);border-radius:8px;border:1px solid var(--border);display:none;"></div>
  <div id="tc_tooltip" style="font-size:11px;color:var(--txt2);margin-top:4px;min-height:28px;padding:4px 8px;background:var(--card);border-radius:8px;border:1px solid var(--border);display:none;"></div>
  <div id="tc_trade_detail" style="font-size:11px;color:var(--txt2);margin-top:4px;min-height:24px;"></div>
</div>

</div><!-- /tab-sim -->

<!-- ══════════════════════ TAB: АНАЛИТИКА ══════════════════════ -->
<div class="tab-pane" id="tab-analytics">

<div class="panel">
  <div class="sec-lg">📈 Анализ капитала и обучения модели</div>
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

<!-- ══════════════════════ TAB: БОТ (LIVE) ══════════════════════ -->
<div class="tab-pane" id="tab-live">

<div class="panel">
  <div class="sec-lg">Статус и управление</div>
  <div id="bot_status_bar" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px;">
    <span id="bot_state_dot" class="sdot"></span>
    <span id="bot_state_label" style="font-size:12px;font-weight:600;color:var(--txt2);">загружаем...</span>
    <button class="btn-pill" id="btn_pause" onclick="botPause()" style="padding:5px 16px;font-size:11px;">⏸ Пауза</button>
    <button class="btn-pill" id="btn_resume" onclick="botResume()" style="padding:5px 16px;font-size:11px;display:none;">▶ Возобновить</button>
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
      <button class="btn-pill" style="background:rgba(255,60,60,.25);border-color:rgba(255,60,60,.5);color:#ff6060;padding:5px 14px;font-size:11px;" onclick="botClose()">✕ Закрыть</button>
      <button class="btn-pill" style="background:rgba(255,60,60,.15);border-color:rgba(255,60,60,.4);color:#ff8080;padding:5px 14px;font-size:11px;" onclick="botCloseAll()">✕ Закрыть все</button>
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
      <button class="btn-pill" style="padding:5px 16px;font-size:11px;" onclick="botAdopt()">📥 Передать боту</button>
    </div>
    <div id="adopt_status" style="font-size:11px;color:var(--txt3);margin-top:6px;"></div>
  </div>
  <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border2);">
    <div class="sec" style="margin-bottom:8px;">Переставить стоп/тейк открытой позиции</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <label>Тикер <input type="text" class="inp mid" id="ms_ticker" placeholder="SBER" style="width:80px;"></label>
      <label>Новый стоп <input type="number" class="inp mid" id="ms_stop" placeholder="242.00" step="0.01" style="width:90px;"></label>
      <label>Новый тейк <input type="number" class="inp mid" id="ms_take" placeholder="(не менять)" step="0.01" style="width:100px;"></label>
      <button class="btn-pill" style="padding:5px 16px;font-size:11px;" onclick="botMoveStop()">📐 Переставить</button>
    </div>
    <div id="ms_status" style="font-size:11px;color:var(--txt3);margin-top:6px;"></div>
  </div>
</div>

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
  <div class="sec-lg">Настройки по тикерам</div>
  <table class="scen-table">
    <thead><tr>
      <th>Тикер</th><th>Торгуется</th><th>Режим (signal_only)</th>
      <th>LONG Take</th><th>LONG Stop</th><th>SHORT Take</th><th>SHORT Stop</th>
    </tr></thead>
    <tbody id="ov_table"></tbody>
  </table>
</div>

</div><!-- /tab-live -->

<script>
document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => c.classList.toggle('active')));

function filterInstrKind(kind) {{
  if (kind === 'all') {{
    document.querySelectorAll('.chip').forEach(c => c.style.display = '');
    return;
  }}
  // toggle: если все чипы этого типа активны — снять все, иначе — включить все
  const ofKind = Array.from(document.querySelectorAll('.chip[data-kind="' + kind + '"]'));
  const allActive = ofKind.every(c => c.classList.contains('active'));
  ofKind.forEach(c => allActive ? c.classList.remove('active') : c.classList.add('active'));
}}

function setAllChips(active) {{
  document.querySelectorAll('.chip').forEach(c => {{
    if (c.style.display !== 'none') {{
      active ? c.classList.add('active') : c.classList.remove('active');
    }}
  }});
}}

let _statusPollTimer = null;

function showTab(name) {{
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  event.currentTarget.classList.add('active');
  if (name === 'live') {{
    loadBotStatus(); loadOverrides(); loadAutoAtr();
    if (!_statusPollTimer) _statusPollTimer = setInterval(loadBotStatus, 30000);
  }} else {{
    if (_statusPollTimer) {{ clearInterval(_statusPollTimer); _statusPollTimer = null; }}
  }}
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

function methodStatsToHtml(ms) {{
  if (!ms || !Object.keys(ms).length) return '';
  // Сортируем по agree_n desc, оставляем методы где есть хоть одна сделка
  const rows = Object.entries(ms)
    .filter(([, s]) => s.agree_n > 0 || s.disagree_n > 0)
    .sort((a, b) => (b[1].agree_n + b[1].disagree_n) - (a[1].agree_n + a[1].disagree_n));
  if (!rows.length) return '';
  let html = '<table style="font-size:11px;border-collapse:collapse;width:100%;margin-top:4px">';
  html += '<tr style="color:var(--txt3)"><th style="text-align:left;padding:1px 6px">метод</th>'
        + '<th style="padding:1px 6px">за n</th><th style="padding:1px 6px">за win%</th>'
        + '<th style="padding:1px 6px">против n</th><th style="padding:1px 6px">против win%</th></tr>';
  for (const [name, s] of rows) {{
    const agWr = s.agree_win_rate !== null && s.agree_win_rate !== undefined ? (s.agree_win_rate*100).toFixed(0)+'%' : '—';
    const disWr = s.disagree_win_rate !== null && s.disagree_win_rate !== undefined ? (s.disagree_win_rate*100).toFixed(0)+'%' : '—';
    const agStyle = s.agree_win_rate !== null && s.agree_win_rate > 0.6 ? 'color:var(--pos)' : (s.agree_win_rate !== null && s.agree_win_rate < 0.4 ? 'color:var(--neg)' : '');
    const disStyle = s.disagree_win_rate !== null && s.disagree_win_rate > 0.6 ? 'color:var(--neg)' : (s.disagree_win_rate !== null && s.disagree_win_rate < 0.4 ? 'color:var(--pos)' : '');
    html += `<tr><td style="padding:1px 6px">${{name}}</td>`
          + `<td style="text-align:right;padding:1px 6px">${{s.agree_n}}</td>`
          + `<td style="text-align:right;padding:1px 6px;${{agStyle}}">${{agWr}}</td>`
          + `<td style="text-align:right;padding:1px 6px">${{s.disagree_n}}</td>`
          + `<td style="text-align:right;padding:1px 6px;${{disStyle}}">${{disWr}}</td></tr>`;
  }}
  html += '</table>';
  return html;
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

// Накопленные строки текущего прогона — храним как данные, не HTML, чтобы
// можно было перерисовывать таблицу (фильтр "скрыть нулевые", итоговая
// строка) без повторного запроса к серверу.
let _backtestRows = [];
let _droppedRows = [];

function _isZeroResult(r) {{
  // "нулевой результат" — тикер досчитан, но сделок не нашлось (n_trades===0),
  // а не ошибка/пропуск (у тех n_trades вообще не определён).
  return r.n_trades !== undefined && r.n_trades === 0;
}}

function summaryRowToHtml(rows) {{
  const valid = rows.filter(r => r.win_rate !== undefined && r.n_trades > 0);
  if (!valid.length) return '';
  const totalTrades = valid.reduce((s, r) => s + r.n_trades, 0);
  // Средневзвешенно по числу сделок — тикер с 2 сделками не должен иметь
  // тот же вес в среднем, что тикер с 80.
  const avgWin = valid.reduce((s, r) => s + r.win_rate * r.n_trades, 0) / totalTrades;
  const avgExp = valid.reduce((s, r) => s + (r.expectancy_pct || 0) * r.n_trades, 0) / totalTrades;
  const avgR = valid.reduce((s, r) => s + (r.avg_r || 0) * r.n_trades, 0) / totalTrades;
  return `<tr style="font-weight:bold;border-top:2px solid var(--txt3);">` +
    `<td>ИТОГО (${{valid.length}} тикер(ов))</td><td></td><td>${{totalTrades}}</td>` +
    `<td>${{(avgWin * 100).toFixed(1)}}%</td><td>${{avgR.toFixed(2)}}</td>` +
    `<td>${{(avgExp * 100).toFixed(2)}}%</td><td></td></tr>`;
}}

function renderResultsTable() {{
  const table = document.getElementById('results');
  const hideZero = document.getElementById('hide_zero').checked;
  const shown = hideZero ? _backtestRows.filter(r => !_isZeroResult(r)) : _backtestRows;
  let html = '<tr><th>Тикер</th><th>Режим</th><th>Сделок</th><th>Win%</th><th>avg R</th><th>Exp%</th><th>M1/M2/M3 win% (когда согласны)</th></tr>';
  html += droppedToHtml(_droppedRows);
  html += rowsToHtml(shown);
  html += summaryRowToHtml(shown);
  table.innerHTML = html;
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
    const parts = tickers.map(t => {{
      const p = progress[t];
      const status = p ? (statusRu[p.status] || p.status) : 'в очереди';
      const cls = p && p.status === 'готово' ? 'color:var(--pos);' : (p && p.status.startsWith('ошибка') ? 'color:var(--neg);' : '');
      return `<span style="${{cls}}">${{t}}: ${{status}}</span>`;
    }});

    // Общий ETA: средн. время на завершённый тикер (от старта прогона) ×
    // сколько тикеров ещё не done — грубо, но по мере прогресса точнее
    // (первые тикеры обычно дороже из-за прогрева кэша/расчёта индикаторов).
    const total = tickers.length;
    const doneCount = tickers.filter(t => progress[t] && DONE_STATUSES.has(progress[t].status)).length;
    const elapsedSec = (Date.now() - startedAt) / 1000;
    let overall = `Готово ${{doneCount}}/${{total}}`;
    if (doneCount > 0 && doneCount < total) {{
      const etaSec = (elapsedSec / doneCount) * (total - doneCount);
      overall += ` · осталось ~${{_fmtEta(etaSec)}}`;
    }} else if (doneCount === 0 && total > 1) {{
      overall += ` · считаю время...`;
    }}
    el.innerHTML = `<div style="margin-bottom:4px;font-weight:600;">${{overall}}</div>` + parts.join(' &nbsp;·&nbsp; ');
  }};
  render({{}});
  _progressTimer = setInterval(async () => {{
    try {{
      const resp = await fetch('/api/progress');
      const data = await resp.json();
      render(data.progress || {{}});
    }} catch (e) {{ /* сетевая ошибка опроса — не критично, просто не обновили */ }}
  }}, 800);
}}

function stopProgressPolling() {{
  if (_progressTimer) {{ clearInterval(_progressTimer); _progressTimer = null; }}
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
  _droppedRows = filtered.dropped;
  renderResultsTable();

  document.getElementById('status').textContent =
    `Считаю ${{tickers.length}} тикер(ов) параллельно (до __BACKTEST_WORKERS__ одновременно)...`;
  startProgressPolling(tickers, 'status_detail');
  let doneCount = 0;
  try {{
    const resp = await fetch('/api/backtest_stream', {{
      method: 'POST', headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{tickers: tickers, days: days, offset_days: offsetDays, atr_take: atrTake, atr_stop: atrStop,
                              tariff: document.getElementById('tariff').value}})
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
        if (evt.done) {{ break; }}
        if (evt.rows) {{
          _backtestRows.push(...evt.rows);
          renderResultsTable();
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
  document.getElementById('status').textContent = `Готово: ${{tickers.length}} тикер(ов)`;
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
    btn.disabled = false; btn.textContent = '🎯 калибровать (narrative+lasso+rules)';
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
  tbody.innerHTML = data.tickers_all.map(t => ovRowHtml(t, data.tickers[t])).join('');
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
    document.getElementById('tc_mode_candle').style.background = mode === 'candle' ? 'var(--mem)' : '';
    document.getElementById('tc_mode_line').style.background   = mode === 'line'   ? 'var(--mem)' : '';
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
  const winRate = nTrades ? (((data.trades || []).filter(t => t.r_multiple > 0).length / nTrades) * 100).toFixed(1) : '—';
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

</script>
</body>
</html>
"""


def get_overrides_payload() -> dict:
    """Текущий data/bot_overrides.json + полный список тикеров (settings.ini + OI) для таблицы."""
    data = load_overrides()
    tickers_all = sorted(set(_all_settings_by_ticker().keys()) | set(load_oi_tickers().keys()))
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
    }


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

    stock_chips = "".join(
        f'<div class="chip active chip-stock" data-ticker="{t}" data-kind="stock" '
        f'title="{"OI" if t in oi_tickers else "settings.ini"}">{t}{"•" if t in oi_tickers else ""}</div>'
        for t in sorted(stocks)
    )
    futures_chips = "".join(
        f'<div class="chip active chip-fut" data-ticker="{t}" data-kind="futures" '
        f'title="фьючерс GO {futures[t].margin_per_lot:.0f}₽">{t}</div>'
        for t in sorted(futures)
    )
    reload_hint = (
        ' <span style="color:#7eb8f7;font-size:11px">⏳ обновляется…</span>'
        if reload_running else ""
    )
    checkboxes = (
        f'<div style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap;align-items:center">'
        f'<button class="btn-pill btn-sm" onclick="filterInstrKind(\'all\');setAllChips(true)">Все</button>'
        f'<button class="btn-pill btn-sm" onclick="filterInstrKind(\'futures\')" style="color:#7eb8f7">🔷 Фьючерсы ({len(futures)})</button>'
        f'<button class="btn-pill btn-sm" onclick="filterInstrKind(\'stock\')" style="color:#a0d4a0">📈 Акции ({len(stocks)})</button>'
        f'<button class="btn-pill btn-sm" onclick="setAllChips(true)">✓ все</button>'
        f'<button class="btn-pill btn-sm" onclick="setAllChips(false)">✗ снять</button>'
        f'<button class="btn-pill btn-sm" onclick="reloadFutures()" style="color:#aaa" title="Загрузить актуальные контракты из API (~10 мин)">🔄 контракты{reload_hint}</button>'
        f'</div>'
        f'{stock_chips}{futures_chips}'
    )
    return (PAGE_HTML
            .replace("__TICKER_CHECKBOXES__", checkboxes)
            .replace("__BACKTEST_WORKERS__", str(BACKTEST_WORKERS))
            .replace("{{", "{").replace("}}", "}")
            ).encode("utf-8")


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
                self._send_json({"error": str(e)})
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
                self._send_json({"error": str(e)})
        elif self.path == "/api/bot_status":
            self._send_json(get_bot_status())
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
            offset_days = int(payload.get("offset_days", 0))
            atr_take_ks = [float(x) for x in str(payload.get("atr_take", "2,3,4")).split(",") if x.strip()]
            atr_stop_ks = [float(x) for x in str(payload.get("atr_stop", "1,1.5,2")).split(",") if x.strip()]
            tariff = payload.get("tariff") or None
            rows, hist = run_backtest_one(ticker, days, atr_take_ks, atr_stop_ks, tariff=tariff, offset_days=offset_days)
            if hist is not None:
                _last_backtest_history_data[ticker] = hist
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

            pool = ProcessPoolExecutor(max_workers=min(BACKTEST_WORKERS, len(tickers)))
            _register_pool(pool)
            try:
                fs = {
                    pool.submit(run_backtest_one, t, days, atr_take_ks, atr_stop_ks,
                                tariff=tariff, progress=progress, offset_days=offset_days): t
                    for t in tickers
                }
                for fut in as_completed(fs):
                    if _cancel_event.is_set():
                        break
                    t = fs[fut]
                    try:
                        rows, hist = fut.result()
                        if hist is not None:
                            _last_backtest_history_data[t] = hist
                    except Exception as ex:
                        rows = [{"ticker": t, "mode": "ошибка", "error": str(ex)}]
                        _set_progress(progress, t, "ошибка")
                    all_rows.extend(rows)
                    try:
                        _sse({"ticker": t, "rows": rows})
                    except Exception:
                        break  # клиент отвалился
            finally:
                _unregister_pool(pool)
                pool.shutdown(wait=False, cancel_futures=True)

            if _cancel_event.is_set():
                _mark_unfinished_cancelled(progress, tickers)

            _last_result["backtest"] = {"rows": all_rows}
            try:
                _sse({"done": True})
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
        elif self.path == "/api/reload_futures":
            started = _start_futures_reload_bg()
            running = _futures_reload_running.is_set()
            self._send_json({"started": started, "running": running})
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
            tickers = payload.get("tickers", [])
            days = int(payload.get("days", 90))
            if not tickers:
                self._send_json({"error": "нет тикеров"}, status=400)
            else:
                result = run_calibration_pipeline(tickers, days)
                self._send_json(result)
        elif self.path == "/api/cancel":
            was_running = request_cancel()
            self._send_json({"cancelled": was_running})
        elif self.path == "/api/bot_control":
            action = payload.get("action", "")
            ticker = payload.get("ticker", "")
            self._send_json(bot_control_action(action, ticker))
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
