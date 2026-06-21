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

import multiprocessing
import threading
import time
import traceback
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
    by_ticker = _strategy_settings_by_ticker()
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


def run_backtest_one(
        ticker: str, days: int, atr_take_ks: list[float], atr_stop_ks: list[float],
        tariff: str | None = None, atr_scale_exps: list[float] | None = None,
        progress: dict | None = None,
) -> list[dict]:
    """
    Прогоняет бэктест по одному тикеру. Возвращает список строк-результатов
    (как в compare_take_stop.py: fixed + лучшая ATR-комбинация),
    либо строку с ошибкой и советом, если тикер упал.
    """
    if progress is None:
        progress = _get_progress_proxy()
    by_ticker = _strategy_settings_by_ticker()
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
        _wire_history(strategy)
        if strategy is None or not hasattr(strategy, "backtest_barriers"):
            rows.append({"ticker": ticker, "mode": "пропуск",
                         "error": "стратегия не поддерживает backtest_barriers"})
            _set_progress(progress, ticker, "пропуск")
            return rows

        try:
            candles = get_candles_cached(ticker, strategy_settings.figi, days, _market_data, _db)
        except RequestError as ex:
            rows.append({"ticker": ticker, "mode": "ошибка API", "error": str(ex.details)})
            _set_progress(progress, ticker, "ошибка API")
            return rows

        if not candles:
            rows.append({"ticker": ticker, "mode": "нет истории", "error": ""})
            _set_progress(progress, ticker, "нет истории")
            return rows

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
            for day in sorted(by_day.keys()):
                day_signals = by_day[day]
                if len(past_signals) >= AUTO_ATR_MIN_TRADES:
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
                                                                atr_scale_exp=ex, tariff=tariff, record_history=False)
                                if r["n_trades"] < AUTO_ATR_MIN_TRADES:
                                    continue
                                if best is None or r["expectancy_pct"] > best[1]:
                                    best = ((tk, sk, ex), r["expectancy_pct"])
                    if best is not None:
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
        return rows

    _set_progress(progress, ticker, "готово")
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
    _cancel_event.clear()
    progress = _get_progress_proxy()
    for ticker in tickers:
        _set_progress(progress, ticker, "в очереди")

    if len(tickers) <= 1:
        rows: list[dict] = []
        for ticker in tickers:
            if _cancel_event.is_set():
                break
            rows.extend(run_backtest_one(ticker, days, atr_take_ks, atr_stop_ks, tariff=tariff, progress=progress))
        if _cancel_event.is_set():
            _mark_unfinished_cancelled(progress, tickers)
        return rows

    by_ticker_rows: dict[str, list[dict]] = {}
    pool = ProcessPoolExecutor(max_workers=min(BACKTEST_WORKERS, len(tickers)))
    _register_pool(pool)
    try:
        futures = {
            pool.submit(run_backtest_one, ticker, days, atr_take_ks, atr_stop_ks, tariff=tariff, progress=progress): ticker
            for ticker in tickers
        }
        for fut in as_completed(futures):
            if _cancel_event.is_set():
                break
            ticker = futures[fut]
            try:
                by_ticker_rows[ticker] = fut.result()
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
    return rows


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
    by_ticker = _strategy_settings_by_ticker()
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
            candles = get_candles_cached(ticker, strategy_settings.figi, days, _market_data, _db)
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
  <!-- 150+ дней нужно для "разогрева" M1/M2/M3: regime_method_performance
       (effWR кластеров) требует 90 дней накопленной истории скоров, иначе
       _MIN_OBS не набирается и M1=M2=M3 (см. cluster_models.py) — бэктест
       короче 90 дней молчит почти весь прогон. -->
  <label>Дней истории <input type="number" class="inp mid" id="days" value="150" min="1" max="240"></label>
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
  <button class="btn-pill" style="background:var(--neg);" onclick="cancelRun()">⏹ СТОП</button>
  <span id="status"></span>
  <div id="status_detail" style="font-size:11px;color:var(--txt3);margin-top:6px;"></div>
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
  <label><input type="checkbox" id="ov_orderbook"> Стакан (10 уровней): срочный выход по дисбалансу заявок
    (доп. живая подписка к API, выключено по умолчанию; работает только вместе с адаптивным выходом)
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

<div class="panel">
  <h3>Диагностика стратегии (как сейчас считается композит)</h3>
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
  startProgressPolling(tickers, 'status_detail');
  try {{
    const resp = await fetch('/api/backtest', {{
      method: 'POST', headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{tickers: tickers, days: days, atr_take: atrTake, atr_stop: atrStop,
                              tariff: document.getElementById('tariff').value}})
    }});
    const data = await resp.json();
    table.innerHTML += rowsToHtml(data.rows);
  }} catch (e) {{
    // Соединение могло оборваться уже ПОСЛЕ того как сервер досчитал
    // результат (видно по прогрессу — он дошёл до "готово"), но не успел
    // отправить ответ. Пробуем забрать его из кэша вместо повторного счёта.
    try {{
      const r2 = await fetch('/api/last_result?kind=backtest');
      const d2 = await r2.json();
      if (d2 && d2.rows) {{
        table.innerHTML += rowsToHtml(d2.rows);
        table.innerHTML += `<tr><td colspan="6" style="color:var(--txt3);">⚠ соединение оборвалось, результат восстановлен из кэша</td></tr>`;
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
  document.getElementById('ov_orderbook').checked = data.orderbook_enabled === true;
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
        "orderbook_enabled": data.get("orderbook_enabled"),
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
    orderbook_enabled = payload.get("orderbook_enabled")
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
        "orderbook_enabled": orderbook_enabled,
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
            _last_result["backtest"] = {"rows": rows}
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
            _last_result["portfolio_sim"] = result
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
        elif self.path == "/api/cancel":
            was_running = request_cancel()
            self._send_json({"cancelled": was_running})
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
