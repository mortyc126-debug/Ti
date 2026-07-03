"""
ticker_universe.py — гибкий выбор тикеров для [FUTURES_TRADING] BASE_TICKERS,
настраиваемый с дашборда без правки settings.ini и без перезапуска процесса.

Режимы (data/ticker_universe.json):
  mode="manual" — ручной список base_tickers (поле manual_tickers)
  mode="top_n"  — топ-N по «востребованности» среди кандидатов, отфильтрованных
                  по типу актива (stock/currency/metal/commodity/index/foreign)

trader.py читает resolved_tickers ОДИН раз в день, в начале trade_day() —
новый список применяется со следующей торговой сессии, не мгновенно посреди
дня (стратегии уже подписаны на стрим свечей за сегодня, см.
trading/trade_service.py::__working_loop).
"""
import json
import logging
import math
import os

logger = logging.getLogger(__name__)

UNIVERSE_FILE = "data/ticker_universe.json"

ASSET_TYPES = ("stock", "currency", "metal", "commodity", "index", "foreign")

# ── Классификация базовых активов ────────────────────────────────────────────
# Строки — ровно в том виде, в каком T-Invest API отдаёт future.basic_asset
# (для акций — обычный тикер, для остального — человекочитаемая строка).
# Курировано по факту использования в settings.ini [FUTURES_TRADING]
# BASE_TICKERS (см. git-историю секции) — не из API, изменение состава линейки
# FORTS потребует ручного дополнения множеств ниже.

RU_STOCKS = frozenset({
    "ABIO", "AFKS", "AFLT", "ALRS", "ASTR", "BANE", "BELU", "BSPB", "CBOM", "CHMF",
    "DOMRF", "ENPG", "FEES", "FESH", "FLOT", "GAZP", "GMKN", "HEAD", "HYDR", "IRAO",
    "IVAT", "KMAZ", "LEAS", "LENT", "LKOH", "MAGN", "MDMG", "MGNT", "MIPO", "MOEX",
    "MREDC", "MTLR", "MTSS", "MVID", "NLMK", "NVTK", "OZON", "PHOR", "PIKK", "PLZL",
    "POSI", "RASP", "RENI", "RNFT", "ROSN", "RTKM", "RTKMP", "RUAL", "SBER", "SBERP",
    "SFIN", "SGZH", "SIBN", "SMLT", "SNGS", "SNGSP", "SOFL", "SVCB", "T", "TATN",
    "TATNP", "TRNFP", "UPRO", "VKCO", "VTBR", "WUSH", "X5", "YDEX",
})

CURRENCIES = frozenset({
    "USD/RUB", "EUR/RUB", "CNY/RUB", "BYN/RUB", "KZT/RUB", "TRY/RUB", "AED/RUB",
    "AMD/RUB", "HKD/RUB", "INR/RUB", "EUR/USD", "GBP/USD", "AUD/USD", "USD/CAD",
    "USD/CHF", "USD/CNY", "USD/INR", "USD/JPY",
})

METALS = frozenset({
    "Золото", "Золото в долларах", "Золото в рублях", "Серебро", "Палладий",
    "Платина", "Алюминий", "Медь", "Никель", "Цинк",
})

COMMODITIES = frozenset({
    "Brent", "Газ (США)", "Газ (Европа)", "Газ микро (США)",
    "Пшеница", "Сахар мировой", "Сахар российский", "Апельсиновый сок",
    "Какао", "Кофе", "Бензин АИ-92", "Бензин АИ-95", "Дизельное топливо летнее",
})

INDICES = frozenset({
    "IMOEX", "RTSI", "RTSI мини",
    "Индекс московской биржи", "Индекс московской биржи в юанях",
    "Индекс металлов и добычи", "Индекс нефти и газа",
    "Индекс потребительского сектора", "Индекс финансов", "Индекс RUONIA",
    "Индекс государственных облигаций", "Индекс волатильности российского рынка",
    "Индекс казначейских облигаций США", "Индекс развивающихся рынков",
    "Индекс Bitcoin", "Индекс Ethereum", "Индекс Ripple", "Индекс Solana", "Индекс Tron",
})

FOREIGN = frozenset({
    "BABA", "BIDU", "Bitcoin-фонд IBIT", "ETHA",
    "Nasdaq 100", "SPDR Dow Jones Industrial Average ETF Trust",
    "SPDR S&P 500 ETF Trust", "iShares Core DAX UCITS ETF",
    "iShares Core EURO STOXX 50 UCITS ETF EUR (Dist)", "iShares Core Nikkei 225 ETF",
    "iShares MSCI India UCITS ETF", "iShares Russel 2000 ETF",
    "MSCI Argentina ETF", "MSCI Brazil ETF", "MSCI China ETF",
    "MSCI Saudi Arabia ETF", "MSCI South Africa ETF",
    "Tracker Fund of Hong Kong ETF", "Invesco PHLX Semiconductor ETF",
    "ASML Holding NV", "АДР JD.com", "АДР Novartis AG", "АДР Pinduoduo Inc",
    "АДР SAP SE", "АДР Sony Corp", "АДР Taiwan Semiconductor Manufacturing",
    "АДР Toyota Motor Corp", "1810", "700",
})

# Полный каталог кандидатов для режима top_n — валидированные basic_asset.
_DEFAULT_CANDIDATES = sorted(RU_STOCKS | CURRENCIES | METALS | COMMODITIES | INDICES | FOREIGN)


def classify(base: str) -> str:
    """Тип актива по строке basic_asset (как в BASE_TICKERS/settings.ini)."""
    if base in CURRENCIES:
        return "currency"
    if base in METALS:
        return "metal"
    if base in COMMODITIES:
        return "commodity"
    if base in INDICES:
        return "index"
    if base in FOREIGN:
        return "foreign"
    return "stock"  # RU_STOCKS + всё неизвестное — безопасный дефолт


def candidates_catalog(extra: list[str] | None = None) -> list[str]:
    """Полный список кандидатов для топ-N, с учётом пользовательских добавлений."""
    all_c = set(_DEFAULT_CANDIDATES)
    if extra:
        all_c |= {x.strip() for x in extra if x.strip()}
    return sorted(all_c)


# ── Файл конфигурации ────────────────────────────────────────────────────────

_DEFAULT_CFG = {
    "mode": "manual",              # "manual" | "top_n"
    "manual_tickers": [],
    "top_n": {
        "n": 20,
        "include_types": list(ASSET_TYPES),
        "exclude_types": [],
    },
    "extra_candidates": [],        # тикеры, добавленные вручную в каталог top_n
    "resolved_tickers": [],
    "last_scores": {},             # {base: {...}} — последний расчёт, для preview в UI
    "computed_at": None,
}


def load_universe() -> dict:
    if not os.path.exists(UNIVERSE_FILE):
        return json.loads(json.dumps(_DEFAULT_CFG))  # deep copy
    try:
        with open(UNIVERSE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        cfg = json.loads(json.dumps(_DEFAULT_CFG))
        cfg.update(data)
        return cfg
    except (json.JSONDecodeError, OSError) as e:
        logger.warning(f"ticker_universe: не удалось прочитать {UNIVERSE_FILE}: {e}")
        return json.loads(json.dumps(_DEFAULT_CFG))


def save_universe(cfg: dict) -> None:
    os.makedirs(os.path.dirname(UNIVERSE_FILE) or ".", exist_ok=True)
    tmp = UNIVERSE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, UNIVERSE_FILE)


def resolved_base_tickers(fallback: list[str]) -> list[str]:
    """То, что должно реально пойти в FuturesTradingSettings.base_tickers сегодня.
    Читается trader.py раз в день (см. trading/trader.py::trade_day). Если файла
    нет или resolved_tickers пуст — используем fallback (BASE_TICKERS из
    settings.ini, обратная совместимость со старыми конфигами)."""
    cfg = load_universe()
    resolved = cfg.get("resolved_tickers") or []
    return resolved if resolved else fallback


# ── Ранжирование (вызывается дашбордом по кнопке «Посчитать») ───────────────

def compute_demand_scores(
    candidates: list[str],
    instrument_service,
    market_data_service,
    mega_alerts_hits: dict[str, int] | None = None,
    volume_days: int = 20,
) -> dict[str, dict]:
    """
    Реальный сигнал востребованности: средний объём последних volume_days
    дневных свечей резолвленного фьючерса (тот же принцип, что и
    MIN_AVG_VOLUME в trader.py) + бонус за частоту MEGA-ALERTS аномалий
    (матчится только по обычным тикерам акций — алёрты по eq-рынку используют
    тикер, а не человекочитаемое имя базиса вроде «Золото»).

    Небыстрая функция — резолвит фьючерс + тянет свечи по каждому кандидату,
    держит реальные лимиты API (margin_delay). Вызывать из фонового потока,
    не из обработчика HTTP-запроса дашборда напрямую.

    Возвращает {base: {"score", "avg_volume", "alerts", "ticker", "error"}} —
    ошибка резолва не бросает исключение (error != None, score=0), чтобы один
    нерезолвящийся кандидат не рушил весь расчёт топа.
    """
    from candle_archive import get_candles_cached

    mega_alerts_hits = mega_alerts_hits or {}
    bulk = instrument_service.futures_by_base_tickers_bulk(candidates, margin_delay=1.2)

    out: dict[str, dict] = {}
    for base in candidates:
        resolved = bulk.get(base)
        if not resolved:
            out[base] = {"score": 0.0, "avg_volume": 0.0, "alerts": 0, "ticker": None, "error": "контракт не найден"}
            continue
        future_settings, figi = resolved
        avg_vol = 0.0
        error = None
        try:
            candles = get_candles_cached(future_settings.ticker, figi, volume_days, market_data_service, None)
            recent = candles[-volume_days:] if candles else []
            if recent:
                avg_vol = sum(float(c.volume) for c in recent) / len(recent)
        except Exception as e:
            error = str(e)
        alerts = mega_alerts_hits.get(base.upper(), 0)
        out[base] = {"score": 0.0, "avg_volume": avg_vol, "alerts": alerts, "ticker": future_settings.ticker, "error": error}

    # Нормировка: объём — основной сигнал, в лог-масштабе (иначе Si с объёмом в
    # сотни тысяч лотов полностью забивает акции с объёмом в тысячи), алёрты —
    # бонус до +20% к скору.
    max_log_vol = max((math.log10(v["avg_volume"] + 1) for v in out.values()), default=1.0) or 1.0
    for v in out.values():
        vol_score = math.log10(v["avg_volume"] + 1) / max_log_vol
        alert_score = min(v["alerts"] / 5, 1.0)  # 5+ алёртов за окно — уже максимум бонуса
        v["score"] = round(0.8 * vol_score + 0.2 * alert_score, 4)
    return out


def resolve_top_n(
    scores: dict[str, dict],
    n: int,
    include_types: list[str],
    exclude_types: list[str],
) -> list[str]:
    """Чистая функция без I/O: фильтр по типу актива + сортировка по score.
    Отдельно от compute_demand_scores — чтобы менять N/фильтры без повторного
    похода в API, если last_scores уже посчитаны и не устарели."""
    include = set(include_types) if include_types else set(ASSET_TYPES)
    exclude = set(exclude_types or ())
    pool = [
        base for base in scores
        if classify(base) in include and classify(base) not in exclude
        and not scores[base].get("error")
    ]
    pool.sort(key=lambda b: scores[b]["score"], reverse=True)
    return pool[:n]
