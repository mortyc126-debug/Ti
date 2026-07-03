"""
oi_layers.py — фоновый сервис слоёв открытого интереса (юр/физ) для squeeze-сигнала.

ОИ на MOEX обновляется раз в 5 минут, на границах :00/:05 (так заявлено на
сайте MOEX) — поэтому поллим раз в 5 минут, выровненные на эти границы, а не
на каждой свече и не "постоянными запросами". Разбивка юр/физ (FutOI) доступна
только через REST analyticalproducts/futoi (AlgoPack, нужен MOEX_TOKEN) — через
стрим Т-Инвестиции (MarketDataStreamService, который даёт только OHLCV-свечи)
эти данные не идут, поэтому полностью без сетевых запросов не обойтись. Но они
редкие, фоновые и не блокируют торговый цикл свечей.

Слои = декомпозиция дневного ΔOI на "слои" {date, price, size} — порт
_buildOiLayers/_buildOiLayerSeries из oi-signal-v10.html. squeeze_score —
доля СВЕЖИХ (<= FRESH_DAYS дней) и КРУПНЫХ (>= SIZABLE доли стороны) слоёв,
которые сейчас в минусе по цене. Это про "кто-то быстро и крупно набрал
позицию, и это вызвало движение" — а не статичный порог вида "физики держат
65% шорта" (это была заглушка из чужой спеки, в реальный метод не переносилась).
"""
import asyncio
import json
import logging
import math
import os
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta

__all__ = ("OiLayersService",)

logger = logging.getLogger(__name__)

POLL_MINUTES = 5     # ОИ обновляется раз в 5 минут на границах :00/:05
FRESH_DAYS = 5        # слой младше — "свежий"
SIZABLE = 0.15        # доля стороны, начиная с которой слой "крупный"
HISTORY_FILE = "data/oi_daily.json"
MOEX_ISS = "https://iss.moex.com/iss"

# Кеш: тикер акции -> список {secid, lasttradedate} полученных с MOEX ISS.
# Заполняется лениво при первом вызове _get_current_fut_ticker().
_FUTOI_CONTRACTS_CACHE: dict[str, list[dict]] = {}


def _fetch_iss_contracts(stock_ticker: str) -> list[dict]:
    """
    Запрашивает MOEX ISS (публично, без токена) список фьючерсных контрактов
    на данный акционный тикер. Возвращает [{secid, lasttradedate}].
    Ошибки не бросаем — возвращаем пустой список и логируем.
    """
    contracts: dict[str, str] = {}

    # Активные контракты с доски RFUD (квартальные фьючерсы)
    try:
        url = (f"{MOEX_ISS}/engines/futures/markets/forts/boards/RFUD/securities.json"
               f"?iss.meta=off&securities.columns=SECID,LASTTRADEDATE")
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = json.load(resp)
        block = data.get("securities", {})
        cols = block.get("columns", [])
        rows = block.get("data", [])
        si = cols.index("SECID") if "SECID" in cols else -1
        li = cols.index("LASTTRADEDATE") if "LASTTRADEDATE" in cols else -1
        if si >= 0 and li >= 0:
            for row in rows:
                sid, ltd = str(row[si] or ""), str(row[li] or "")
                if sid.upper().startswith(stock_ticker.upper()) and ltd:
                    contracts[sid] = ltd[:10]
    except Exception as e:
        logger.debug(f"oi_layers: ISS RFUD запрос упал для {stock_ticker}: {e}")

    # Поиск по имени — покрывает контракты недоступные в текущем стакане
    try:
        params = urllib.parse.urlencode({"q": stock_ticker, "iss.meta": "off",
                                         "securities.columns": "secid,matdate,type"})
        url = f"{MOEX_ISS}/securities.json?{params}"
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = json.load(resp)
        block = data.get("securities", {})
        cols = block.get("columns", [])
        rows = block.get("data", [])
        si  = cols.index("secid")   if "secid"   in cols else -1
        mi  = cols.index("matdate") if "matdate" in cols else -1
        ti  = cols.index("type")    if "type"    in cols else -1
        if si >= 0 and mi >= 0:
            for row in rows:
                sid = str(row[si] or "")
                mat = str(row[mi] or "")
                typ = str(row[ti] or "") if ti >= 0 else ""
                if sid.upper().startswith(stock_ticker.upper()) and mat and "future" in typ.lower():
                    contracts.setdefault(sid, mat[:10])
    except Exception as e:
        logger.debug(f"oi_layers: ISS securities search упал для {stock_ticker}: {e}")

    return sorted(
        [{"secid": k, "lasttradedate": v} for k, v in contracts.items()],
        key=lambda x: x["lasttradedate"],
    )


def _get_current_fut_ticker(stock_ticker: str) -> str | None:
    """
    Возвращает тикер фьючерсного контракта, активного сегодня, для данной акции.
    Использует кеш; при отсутствии — запрашивает MOEX ISS.
    """
    if stock_ticker not in _FUTOI_CONTRACTS_CACHE:
        _FUTOI_CONTRACTS_CACHE[stock_ticker] = _fetch_iss_contracts(stock_ticker)

    contracts = _FUTOI_CONTRACTS_CACHE[stock_ticker]
    today = date.today().isoformat()
    candidates = [c for c in contracts if c["lasttradedate"] >= today]
    if not candidates:
        return None
    return min(candidates, key=lambda x: x["lasttradedate"])["secid"]

def _load_moex_token() -> str | None:
    token = os.getenv("MOEX_TOKEN")
    if token:
        return token
    try:
        from configparser import ConfigParser
        ini = ConfigParser()
        ini.read("settings.ini", encoding="utf-8")
        return ini.get("MOEX", "TOKEN", fallback=None) or None
    except Exception:
        return None

MOEX_TOKEN = _load_moex_token()
FUTOI_URL = "https://apim.moex.com/iss/analyticalproducts/futoi/securities.json"


@dataclass
class OiLayer:
    layer_date: str
    price: float
    size: float

    def age_days(self, last_date: str) -> int:
        try:
            return (date.fromisoformat(last_date) - date.fromisoformat(self.layer_date)).days
        except ValueError:
            return 0

    def pnl_pct(self, cur_price: float, direction: str) -> float:
        if self.price <= 0:
            return 0.0
        diff = (cur_price - self.price) / self.price
        return diff if direction == "long" else -diff


def _build_layers(rows: list[dict]) -> dict:
    """
    rows — снэпшоты по возрастанию tradedate: {tradedate, price, long, short}
    (long/short уже сложены yur+fiz). Наращивание ΔOI кладёт новый слой,
    схлопывание режет существующие слои pro-rata (порядок закрытия позиций
    по агрегату FutOI не известен).
    """
    layers = {"long": [], "short": []}
    prev = {"long": 0.0, "short": 0.0}
    for r in rows:
        for side in ("long", "short"):
            qty = float(r.get(side) or 0)
            delta = qty - prev[side]
            if delta > 1e-9:
                layers[side].append(OiLayer(layer_date=r["tradedate"], price=float(r.get("price") or 0), size=delta))
            elif delta < -1e-9:
                shrink = -delta
                total = sum(l.size for l in layers[side]) or 1.0
                frac = min(1.0, shrink / total)
                for l in layers[side]:
                    l.size *= (1 - frac)
                layers[side] = [l for l in layers[side] if l.size > 1e-6]
            prev[side] = qty
    return layers


def _squeeze_from_layers(layers: dict, last_date: str, cur_price: float) -> dict:
    """
    squeeze_up   — шорты недавно крупно нарастили и сейчас в минусе
                   (риск шорт-сквиза — цену вынесет вверх)
    squeeze_down — лонги недавно крупно нарастили и сейчас в минусе
                   (риск лонг-сквиза — цену вынесет вниз)
    """
    out = {"squeeze_up": 0.0, "squeeze_down": 0.0}
    for side, key in (("short", "squeeze_up"), ("long", "squeeze_down")):
        total = sum(l.size for l in layers.get(side, []))
        if total <= 0:
            continue
        risky = 0.0
        for l in layers[side]:
            if l.age_days(last_date) > FRESH_DAYS:
                continue
            if l.size / total < SIZABLE:
                continue
            if l.pnl_pct(cur_price, side) < 0:
                risky += l.size
        out[key] = risky / total
    return out


def _fetch_futoi_snapshot(sym: str) -> dict | None:
    """Синхронный (блокирующий) HTTP-запрос — звать только через asyncio.to_thread."""
    if not MOEX_TOKEN:
        logger.warning("oi_layers: MOEX_TOKEN не задан — squeeze-сигнал недоступен")
        return None
    url = f"{FUTOI_URL}?{urllib.parse.urlencode({'ticker': sym, 'iss.meta': 'off', 'limit': 1000})}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {MOEX_TOKEN}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
    except Exception as e:
        logger.warning(f"oi_layers: futoi запрос {sym} упал: {e}")
        return None

    block = data.get("futoi")
    if not block or not block.get("columns") or not block.get("data"):
        return None
    cols = block["columns"]
    rows = [dict(zip(cols, row)) for row in block["data"]]
    rows = [r for r in rows if r.get("ticker") == sym]
    if not rows:
        return None

    by_group = {}
    for r in rows:
        g = str(r.get("clgroup") or "").upper()
        if g not in ("YUR", "FIZ"):
            continue
        if g not in by_group or str(r.get("tradetime") or "") > str(by_group[g].get("tradetime") or ""):
            by_group[g] = r

    tradedate = (by_group.get("YUR") or by_group.get("FIZ") or {}).get("tradedate")
    if not tradedate:
        return None
    yur_long = float(by_group.get("YUR", {}).get("pos_long") or 0)
    yur_short = abs(float(by_group.get("YUR", {}).get("pos_short") or 0))
    fiz_long = float(by_group.get("FIZ", {}).get("pos_long") or 0)
    fiz_short = abs(float(by_group.get("FIZ", {}).get("pos_short") or 0))
    # Число лиц (не контрактов) по сторонам — тот же столбец MOEX FutOI,
    # что использует oi_lab.html (pos_long_num/pos_short_num). Текущий
    # signal_gate.py их не использует (гейт считает только по contracts —
    # conviction/liquidity в него не портированы, см. signal_gate.py docstring),
    # но раз уж запрос к этому же endpoint'у всё равно идёт — сохраняем про запас.
    yur_long_num = float(by_group.get("YUR", {}).get("pos_long_num") or 0)
    yur_short_num = float(by_group.get("YUR", {}).get("pos_short_num") or 0)
    fiz_long_num = float(by_group.get("FIZ", {}).get("pos_long_num") or 0)
    fiz_short_num = float(by_group.get("FIZ", {}).get("pos_short_num") or 0)
    return {
        "tradedate": tradedate,
        "long": yur_long + fiz_long, "short": yur_short + fiz_short,
        "yur_long": yur_long, "yur_short": yur_short,
        "fiz_long": fiz_long, "fiz_short": fiz_short,
        "yur_long_num": yur_long_num, "yur_short_num": yur_short_num,
        "fiz_long_num": fiz_long_num, "fiz_short_num": fiz_short_num,
    }


def _divergence_correction(score: float, rows: list[dict], long_key: str, short_key: str, sign: float) -> float:
    """
    Порт дивергенции ΔOI×ΔPrice из m_INST_OI/m_RETAIL_CONTRA (oi-signal-v10.html):
    ОИ и цена двигаются в одну сторону — новые позиции, тренд подтверждён,
    усиливаем сигнал; ОИ и цена расходятся — закрытие позиций, сигнал слабее.
    sign=+1 для INST_OI (тренд усиливает score в сторону движения цены),
    sign=-1 для RETAIL_CONTRA (зеркально — толпа доливает за ценой, FOMO).
    Нужны минимум 2 дня снэпшотов с записанной ценой (см. _poll_once).
    """
    if len(rows) < 2:
        return score
    r1, r0 = rows[-1], rows[-2]
    price1, price0 = float(r1.get("price") or 0), float(r0.get("price") or 0)
    if price1 <= 0 or price0 <= 0:
        return score
    d_price = price1 - price0
    net1 = float(r1.get(long_key) or 0) - float(r1.get(short_key) or 0)
    net0 = float(r0.get(long_key) or 0) - float(r0.get(short_key) or 0)
    d_oi = net1 - net0
    if d_oi == 0 or d_price == 0:
        return score
    same_sign = (d_oi > 0) == (d_price > 0)
    if same_sign:
        return math.tanh(score * 1.3 + sign * math.copysign(0.2, d_price))
    return score * 0.4


def _delta_quadrant_score(rows: list[dict], n: int = 3) -> float:
    """
    Динамический квадрант: смотрим ΔОИ юр и физ за последние n снэпшотов.
    Оба набирают лонг одновременно → медвежий сигнал (перегруженная сторона).
    Оба набирают шорт → бычий (шорт-сквиз потенциал).
    ЮР лонг + ФИЗ шорт → бычий (умные vs толпа). ЮР шорт + ФИЗ лонг → медвежий.
    Возвращает [-1..+1], >0 бычий, <0 медвежий.
    """
    if len(rows) < 2:
        return 0.0
    window = rows[-min(n + 1, len(rows)):]
    d_yur_long = d_yur_short = d_fiz_long = d_fiz_short = 0.0
    for i in range(1, len(window)):
        r1, r0 = window[i], window[i - 1]
        d_yur_long  += float(r1.get("yur_long")  or 0) - float(r0.get("yur_long")  or 0)
        d_yur_short += float(r1.get("yur_short") or 0) - float(r0.get("yur_short") or 0)
        d_fiz_long  += float(r1.get("fiz_long")  or 0) - float(r0.get("fiz_long")  or 0)
        d_fiz_short += float(r1.get("fiz_short") or 0) - float(r0.get("fiz_short") or 0)

    # Нетто-направление ΔОИ каждой группы
    d_yur = d_yur_long - d_yur_short
    d_fiz = d_fiz_long - d_fiz_short
    total = abs(d_yur) + abs(d_fiz)
    if total < 1e-9:
        return 0.0

    if d_yur > 0 and d_fiz > 0:
        # Оба доливают лонг — перегрев, медвежий
        intensity = (d_yur + d_fiz) / total  # всегда 1.0 при одном знаке
        return -math.tanh(intensity * 1.5) * 0.7

    if d_yur < 0 and d_fiz < 0:
        # Оба доливают шорт — перегрев шорта, бычий
        intensity = (abs(d_yur) + abs(d_fiz)) / total
        return math.tanh(intensity * 1.5) * 0.7

    if d_yur > 0 and d_fiz < 0:
        # ЮР набирает лонг, ФИЗ шортит — умные vs толпа → бычий
        return math.tanh((d_yur - d_fiz) / total * 2.0) * 0.85

    if d_yur < 0 and d_fiz > 0:
        # ЮР шортит, ФИЗ набирает лонг → медвежий
        return -math.tanh((abs(d_yur) + d_fiz) / total * 2.0) * 0.85

    return 0.0


def _absorption_score(rows: list[dict], n: int = 3) -> float:
    """
    ОИ растёт (обе стороны доливают), а цена не реагирует → поглощение.
    Кто-то снаружи (маркетмейкер) продаёт в лонг или покупает шорт.
    Когда он выйдет — рынок рванёт против перегруженной стороны.
    Возвращает (-1..+1): >0 — поглощение шортов (бычий потенциал), <0 — лонгов (медвежий).
    """
    if len(rows) < 2:
        return 0.0
    window = rows[-min(n + 1, len(rows)):]
    total_d_long = total_d_short = 0.0
    p_start = float(window[0].get("price") or 0)
    p_end   = float(window[-1].get("price") or 0)
    for i in range(1, len(window)):
        r1, r0 = window[i], window[i - 1]
        total_d_long  += max(0.0, float(r1.get("long")  or 0) - float(r0.get("long")  or 0))
        total_d_short += max(0.0, float(r1.get("short") or 0) - float(r0.get("short") or 0))

    oi_growth = total_d_long + total_d_short
    if oi_growth < 1e-9 or p_start <= 0 or p_end <= 0:
        return 0.0

    # Нормируем рост ОИ к среднему значению
    avg_total = sum(float(r.get("long", 0)) + float(r.get("short", 0)) for r in window) / len(window)
    if avg_total < 1e-9:
        return 0.0
    oi_growth_rel = oi_growth / avg_total

    price_move = abs(p_end - p_start) / p_start
    # Поглощение = ОИ растёт, цена стоит (price_move < 0.005 = <0.5%)
    if price_move > 0.01:  # цена двигается — не поглощение
        return 0.0
    stagnation = max(0.0, 1.0 - price_move / 0.005)
    intensity = math.tanh(oi_growth_rel * 3.0) * stagnation

    # Перегружена та сторона, которая больше доливала
    net_bias = total_d_long - total_d_short
    # >0 — лонги перегружены → медвежий, <0 — шорты → бычий
    return -math.copysign(intensity * 0.8, net_bias)


def _inst_oi_score(rows: list[dict]) -> float:
    """
    Порт m_INST_OI: позиция юрлиц (YUR) — "умные деньги" срочного рынка.
    tanh-нелинейность (не линейный клип) + дивергенция ОИ/цены, как в
    oi-signal-v10.html (нет перцентильной истории — берём ветку normScore-фоллбэка).
    > 0 — юрлица в нетто-лонге (бычий сигнал), < 0 — в нетто-шорте.
    """
    if not rows:
        return 0.0
    last = rows[-1]
    long_, short_ = float(last.get("yur_long") or 0), float(last.get("yur_short") or 0)
    total = long_ + short_
    if total <= 0:
        return 0.0
    score = math.tanh(((long_ - short_) / total) * 3)
    return _divergence_correction(score, rows, "yur_long", "yur_short", sign=1.0)


def _retail_contra_score(rows: list[dict]) -> float:
    """
    Порт m_RETAIL_CONTRA: позиция физлиц (FIZ) — контр-индикатор толпы.
    score = -tanh(net_fiz * 2.5): физлица в нетто-лонге → контр-сигнал на падение
    (отрицательный score), в нетто-шорте → контр-сигнал на рост. Дивергенция
    зеркальная INST_OI (sign=-1): толпа доливает вместе с ценой — FOMO,
    усиливаем контр-сигнал; закрывает позиции — сигнал слабее.
    """
    if not rows:
        return 0.0
    last = rows[-1]
    fiz_l, fiz_s = float(last.get("fiz_long") or 0), float(last.get("fiz_short") or 0)
    total = fiz_l + fiz_s
    if total <= 0:
        return 0.0
    score = -math.tanh(((fiz_l - fiz_s) / total) * 2.5)
    return _divergence_correction(score, rows, "fiz_long", "fiz_short", sign=-1.0)


class OiBacktestProvider:
    """
    Провайдер OI-скоров для бэктеста. Читает data/oi_daily.json и
    воспроизводит те же скоры (inst_oi, retail_contra, delta_quadrant,
    absorption, squeeze), что OiLayersService считает в живом режиме, —
    но только на строках, датированных <= текущей дате бэктеста (нет
    заглядывания вперёд).

    Использование:
        prov = OiBacktestProvider.load()
        strategy.set_inst_oi_provider(prov.inst_oi_score)
        strategy.set_retail_contra_provider(prov.retail_contra_score)
        strategy.set_delta_quadrant_provider(prov.delta_quadrant_score)
        strategy.set_oi_absorption_provider(prov.absorption_score)
        strategy.set_squeeze_provider(prov.squeeze_score)
        signals = strategy.backtest_scan_signals(candles, oi_date_hook=prov.set_date)
    """

    def __init__(self, history: dict[str, list[dict]]):
        self._history = history          # {ticker: [{tradedate, long, short, ...}]}
        self._current_date: str = ""
        self._cache: dict[str, dict] = {}  # ticker -> scores (кеш на текущую дату)

    @classmethod
    def load(cls, path: str = HISTORY_FILE) -> "OiBacktestProvider":
        if not os.path.exists(path):
            return cls({})
        try:
            with open(path, encoding="utf-8") as f:
                return cls(json.load(f))
        except Exception as e:
            logger.warning(f"OiBacktestProvider: не удалось загрузить {path}: {e}")
            return cls({})

    def set_date(self, date_str: str) -> None:
        """Вызывается бэктестом при переходе на новый день (oi_date_hook)."""
        if date_str == self._current_date:
            return
        self._current_date = date_str
        self._cache.clear()

    def _scores_for(self, ticker: str) -> dict:
        if ticker in self._cache:
            return self._cache[ticker]
        rows_all = self._history.get(ticker, [])
        if not rows_all or not self._current_date:
            self._cache[ticker] = {}
            return {}
        # Только строки до текущей даты включительно (нет lookahead)
        rows = [r for r in rows_all if str(r.get("tradedate", "")) <= self._current_date]
        if not rows:
            self._cache[ticker] = {}
            return {}
        last = rows[-1]
        price = float(last.get("price") or 0) or None
        layers = _build_layers(rows) if price else {}
        s: dict = {
            "inst_oi": _inst_oi_score(rows),
            "retail_contra": _retail_contra_score(rows),
            "delta_quadrant": _delta_quadrant_score(rows),
            "absorption": _absorption_score(rows),
            "squeeze_up": 0.0,
            "squeeze_down": 0.0,
        }
        if price and layers:
            sq = _squeeze_from_layers(layers, last["tradedate"], price)
            s["squeeze_up"] = sq["squeeze_up"]
            s["squeeze_down"] = sq["squeeze_down"]
        self._cache[ticker] = s
        return s

    def inst_oi_score(self, ticker: str) -> float:
        return self._scores_for(ticker).get("inst_oi", 0.0)

    def retail_contra_score(self, ticker: str) -> float:
        return self._scores_for(ticker).get("retail_contra", 0.0)

    def delta_quadrant_score(self, ticker: str) -> float:
        return self._scores_for(ticker).get("delta_quadrant", 0.0)

    def absorption_score(self, ticker: str) -> float:
        return self._scores_for(ticker).get("absorption", 0.0)

    def squeeze_score(self, ticker: str, direction: str) -> float:
        s = self._scores_for(ticker)
        return s.get("squeeze_up", 0.0) if direction == "short" else s.get("squeeze_down", 0.0)

    def has_data(self, ticker: str) -> bool:
        return ticker in self._history and bool(self._history[ticker])

    def coverage(self, ticker: str) -> dict:
        """Покрытие истории FutOI по тикеру — для отображения в дашборде:
        сколько дней, за какой диапазон дат. Пусто → OI-методы молчат."""
        rows = self._history.get(ticker, [])
        if not rows:
            return {"has": False, "days": 0, "from": None, "to": None}
        dates = sorted(str(r.get("tradedate", "")) for r in rows if r.get("tradedate"))
        return {"has": True, "days": len(rows),
                "from": dates[0] if dates else None,
                "to": dates[-1] if dates else None}


# ── Мост: тянуть oi_daily из OI-воркера (Cloudflare D1) в локальный формат ──
# Воркер (invest-bot/cf-worker.js, база oi_signal1) собирает ОИ по cron и хранит
# его под ПОЛНЫМ фьючерсным кодом (SECID: SRU6, AEU6, SiZ6 …) — тем же, чем
# ключует бэктест фьючерсов. Поэтому сначала матчим ТОЧНЫЙ код, а если его нет —
# собираем по корню (contractRoot) со сшивкой контрактов по датам (фронт-месяц),
# чтобы длинная история не рвалась на границах роллирования. Для акционных
# тикеров остаётся фолбэк через FUTOI_FULL_MAP. Кладём в data/oi_daily.json —
# тот же файл, что читает OiBacktestProvider.

# Порт FUTOI_FULL_MAP из cf-worker.js::futoi2sym — акция → короткий код FutOI.
_FUTOI_FULL_MAP = {
    "SBER": "SBERF", "GAZP": "GAZPF", "LKOH": "LKOHF", "GMKN": "GMKNF",
    "NVTK": "NVTKF", "ROSN": "ROSNF", "TATN": "TATNF", "MGNT": "MGNTF",
    "YNDX": "YDEX", "YDEX": "YD", "IMOEX": "IMOEXF", "GLDR": "GLDRUBF",
    "EURR": "EURRUBF", "CNYR": "CNYRUBF", "USDR": "USDRUBF",
}

# Месяц-код фьючерса → номер месяца (F=янв … Z=дек).
_FUT_MONTH = {"F": 1, "G": 2, "H": 3, "J": 4, "K": 5, "M": 6,
             "N": 7, "Q": 8, "U": 9, "V": 10, "X": 11, "Z": 12}
import re as _re
_CONTRACT_RE = _re.compile(r"^([A-Za-z]+)([FGHJKMNQUVXZ])(\d)$")


def _contract_root(ticker: str) -> str:
    """Порт contractRoot из cf-worker.js: SRU6→SR, AEU6→AE, SiZ6→Si. Иначе сам тикер."""
    m = _CONTRACT_RE.match(ticker or "")
    return m.group(1) if m else (ticker or "")


def _contract_expiry_ym(ticker: str) -> int | None:
    """Месяц экспирации контракта как год*12+месяц (для выбора фронт-месяца).
    Год — одна цифра → ближайший к текущему (…5→2025, 6→2026)."""
    m = _CONTRACT_RE.match(ticker or "")
    if not m:
        return None
    mon = _FUT_MONTH.get(m.group(2).upper())
    if not mon:
        return None
    d = int(m.group(3))
    base = (date.today().year // 10) * 10
    year = base + d
    if year < date.today().year - 3:   # цифра указывает на следующее десятилетие
        year += 10
    return year * 12 + mon


def _futoi2sym(ticker: str) -> str:
    """Порт futoi2sym из cf-worker.js: FutOI-тикер → короткий код серии."""
    up = (ticker or "").upper()
    for k, v in _FUTOI_FULL_MAP.items():
        if up.startswith(k):
            return v
    return up[:2] if len(up) >= 2 else up


def _stock_oi_sym(stock_ticker: str) -> str:
    """Короткий код FutOI для акционного тикера (как ключует воркер)."""
    up = (stock_ticker or "").upper()
    if up in _FUTOI_FULL_MAP:
        return _FUTOI_FULL_MAP[up]
    return up[:2] if len(up) >= 2 else up


def _worker_get(base_url: str, path: str, timeout: int = 20):
    url = base_url.rstrip("/") + path
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def _map_worker_rows(rows: list[dict], src: str) -> list[dict]:
    """Строки D1 oi_daily → локальный формат."""
    out = []
    for r in rows or []:
        yl = float(r.get("yur_long") or 0);  ys = float(r.get("yur_short") or 0)
        fl = float(r.get("fiz_long") or 0);  fs = float(r.get("fiz_short") or 0)
        td = str(r.get("tradedate") or "")
        if not td:
            continue
        out.append({
            "tradedate": td, "price": float(r.get("price") or 0),
            "yur_long": yl, "yur_short": ys, "fiz_long": fl, "fiz_short": fs,
            "long": yl + fl, "short": ys + fs, "src_ticker": src,
        })
    return out


def _worker_catalog_keys(base_url: str, timeout: int = 20) -> list[str]:
    try:
        catalog = _worker_get(base_url, "/db/tickers", timeout)
    except Exception as e:
        logger.warning(f"OI-воркер /db/tickers упал: {e}")
        return []
    return [str(r.get("ticker") or "") for r in (catalog or []) if r.get("ticker")]


def fetch_worker_oi_daily(base_url: str, ticker: str, timeout: int = 20) -> list[dict]:
    """История oi_daily по тикеру из OI-воркера в локальном формате. Тикер может
    быть полным фьючерсным кодом (AEU6) или акционным (SBER). [] если нет."""
    if not base_url:
        return []
    keys = _worker_catalog_keys(base_url, timeout)
    if not keys:
        return []
    up = (ticker or "").upper()
    kmap = {k.upper(): k for k in keys}

    # 1. Точное совпадение кода (бэктест фьючерсов ключует ровно так же).
    if up in kmap:
        try:
            rows = _worker_get(base_url, "/db/oidaily?ticker=" + urllib.parse.quote(kmap[up]), timeout)
            return sorted(_map_worker_rows(rows, kmap[up]), key=lambda x: x["tradedate"])
        except Exception as e:
            logger.warning(f"OI-воркер /db/oidaily?ticker={kmap[up]} упал: {e}")
            return []

    # 2. Сборка по корню контракта со сшивкой по датам (фронт-месяц на день).
    root = _contract_root(ticker)
    same_root = [k for k in keys if _contract_root(k).upper() == root.upper()] if _CONTRACT_RE.match(up) else []
    # 3. Для акций — совпадение по короткому коду серии futoi2sym.
    if not same_root:
        target = _stock_oi_sym(ticker)
        same_root = [k for k in keys if _futoi2sym(k) == target] \
                    or [k for k in keys if k.upper().startswith(target)]
    if not same_root:
        return []

    # Тянем каждый контракт и сшиваем: на каждую дату — контракт-фронт (ближайшая
    # экспирация >= даты; если все истекли — самый поздний). Один код → просто он.
    by_date: dict[str, tuple[int, dict]] = {}
    fetched_any = False
    for k in same_root:
        try:
            rows = _worker_get(base_url, "/db/oidaily?ticker=" + urllib.parse.quote(k), timeout)
        except Exception as e:
            logger.warning(f"OI-воркер /db/oidaily?ticker={k} упал: {e}")
            continue
        fetched_any = True
        exp = _contract_expiry_ym(k) or 10 ** 9
        for r in _map_worker_rows(rows, k):
            td = r["tradedate"]
            try:
                td_ym = int(td[:4]) * 12 + int(td[5:7])
            except Exception:
                td_ym = 0
            # приоритет: контракт, ещё не истёкший на дату, с ближайшей экспирацией
            not_expired = exp >= td_ym
            rank = (0 if not_expired else 1, exp)
            prev = by_date.get(td)
            if prev is None or rank < prev[0]:
                by_date[td] = (rank, r)
    if not fetched_any:
        return []
    return [v[1] for _, v in sorted(by_date.items())]


def sync_worker_oi(base_url: str, tickers: list[str], path: str = HISTORY_FILE,
                   timeout: int = 20) -> dict:
    """Тянет oi_daily из воркера по списку акционных тикеров и пишет в локальный
    data/oi_daily.json (ключ = акционный тикер, как ждёт бэктест). Возвращает
    сводку {ticker: дней}. Существующие тикеры без данных в воркере не трогаем."""
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                history = json.load(f)
        except Exception:
            history = {}
    else:
        history = {}
    summary: dict[str, int] = {}
    log: list[str] = []
    for tk in tickers:
        key = tk.upper()
        rows = fetch_worker_oi_daily(base_url, tk, timeout)
        if not rows:
            summary[key] = len(history.get(key, []))
            log.append(f"{tk}: в воркере нет данных (локально {summary[key]} дн.)")
            continue
        # Дозапись: сливаем по tradedate, свежие строки воркера перекрывают
        # старые той же даты, локальные дни, которых нет в воркере, сохраняем.
        by_date = {str(r.get("tradedate")): r for r in history.get(key, []) if r.get("tradedate")}
        added = 0
        for r in rows:
            d = r["tradedate"]
            if d not in by_date:
                added += 1
            by_date[d] = r
        merged = sorted(by_date.values(), key=lambda x: str(x.get("tradedate")))
        history[key] = merged
        summary[key] = len(merged)
        log.append(f"{tk}: +{added} нов., всего {len(merged)} дн. (воркер, ключ {rows[0].get('src_ticker')})")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False)
    os.replace(tmp, path)
    return {"summary": summary, "total": sum(summary.values()), "log": log}


class OiLayersService:
    """
    Фоновый поллер ОИ. Запускается на торговый день (asyncio.create_task),
    раз в POLL_MINUTES (выровнено на :00/:05) обновляет дневную историю по
    отслеживаемым тикерам и пересчитывает squeeze-score в памяти.
    """

    def __init__(self, price_getter=None):
        """price_getter(stock_ticker) -> float | None — последняя цена акции."""
        self.price_getter = price_getter or (lambda _t: None)
        self._history: dict[str, list[dict]] = {}
        self._scores: dict[str, dict] = {}
        self._load()

    def _load(self):
        if not os.path.exists(HISTORY_FILE):
            return
        try:
            with open(HISTORY_FILE, encoding="utf-8") as f:
                self._history = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"oi_layers: не удалось загрузить историю: {e}")

    def _save(self):
        os.makedirs("data", exist_ok=True)
        try:
            tmp = HISTORY_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._history, f, ensure_ascii=False)
            os.replace(tmp, HISTORY_FILE)
        except OSError as e:
            logger.warning(f"oi_layers: не удалось сохранить историю: {e}")

    async def poll_loop(self, tickers: list[str]) -> None:
        """Бесконечный цикл — отменяется снаружи (task.cancel()) в конце торгового дня."""
        if not tickers:
            return
        try:
            while True:
                await self._sleep_to_next_boundary()
                await self._poll_once(tickers)
        except asyncio.CancelledError:
            logger.debug("oi_layers: poll_loop остановлен")
            raise

    async def _poll_once(self, tickers: list[str]) -> None:
        for ticker in tickers:
            # Берём текущий фьючерсный контракт с MOEX ISS (не генерируем)
            sym = await asyncio.to_thread(_get_current_fut_ticker, ticker)
            if not sym:
                logger.debug(f"oi_layers: нет активного фьючерса для {ticker} — пропускаем")
                continue
            snap = await asyncio.to_thread(_fetch_futoi_snapshot, sym)
            if not snap:
                continue
            # Символ контракта — signal_gate.py метит день роллом (ref_switch),
            # если символ сменился день-в-день, и вырезает такие окна из
            # forward-returns (нерыночный скачок цены при переходе на новый контракт).
            snap["contract"] = sym
            price = self.price_getter(ticker)
            # Цена нужна слоям (entry price для pnl%) и дивергенции ОИ/цены —
            # без неё слои всегда были бы "куплены по нулю" и squeeze не считался.
            if price:
                snap["price"] = price

            hist = self._history.setdefault(ticker, [])
            if hist and hist[-1]["tradedate"] == snap["tradedate"]:
                hist[-1] = snap
            else:
                hist.append(snap)
            hist[:] = hist[-120:]  # храним ~120 последних дней, достаточно для слоёв

            if price:
                layers = _build_layers(hist)
                scores = _squeeze_from_layers(layers, snap["tradedate"], price)
            else:
                scores = self._scores.get(ticker, {"squeeze_up": 0.0, "squeeze_down": 0.0})
            scores["inst_oi"] = _inst_oi_score(hist)
            scores["retail_contra"] = _retail_contra_score(hist)
            scores["delta_quadrant"] = _delta_quadrant_score(hist)
            scores["absorption"] = _absorption_score(hist)
            self._scores[ticker] = scores
        self._save()

    @staticmethod
    async def _sleep_to_next_boundary() -> None:
        now = datetime.utcnow()
        next_minute = (now.minute // POLL_MINUTES + 1) * POLL_MINUTES
        next_time = now.replace(second=0, microsecond=0) + timedelta(minutes=next_minute - now.minute)
        next_time += timedelta(seconds=20)  # запас, чтобы MOEX успел опубликовать снэпшот
        wait = (next_time - datetime.utcnow()).total_seconds()
        if wait > 0:
            await asyncio.sleep(wait)

    def squeeze_score(self, ticker: str, direction: str) -> float:
        """
        direction: "long" | "short" — направление ТЕКУЩЕЙ/предполагаемой позиции.
        Возвращает риск сквиза для этого направления: 0.0 если данных нет.
        """
        scores = self._scores.get(ticker)
        if not scores:
            return 0.0
        # короткая позиция боится squeeze_up (шорты выносит вверх), длинная — squeeze_down
        return scores["squeeze_up"] if direction == "short" else scores["squeeze_down"]

    def is_squeeze_risk(self, ticker: str, direction: str, threshold: float = 0.5) -> bool:
        return self.squeeze_score(ticker, direction) >= threshold

    def inst_oi_score(self, ticker: str) -> float:
        """m_INST_OI: нетто-позиция юрлиц (>0 — лонг, <0 — шорт). 0.0 если данных нет."""
        return self._scores.get(ticker, {}).get("inst_oi", 0.0)

    def retail_contra_score(self, ticker: str) -> float:
        """m_RETAIL_CONTRA: расхождение юр/физ по направлению. 0.0 если данных нет."""
        return self._scores.get(ticker, {}).get("retail_contra", 0.0)

    def delta_quadrant_score(self, ticker: str) -> float:
        """
        Динамический квадрант ΔОИ: кто и куда доливает прямо сейчас.
        >0 бычий (ЮР лонг vs ФИЗ шорт, или оба в шорте = сквиз потенциал).
        <0 медвежий (ЮР шорт vs ФИЗ лонг, или оба в лонге = перегрев).
        """
        return self._scores.get(ticker, {}).get("delta_quadrant", 0.0)

    def absorption_score(self, ticker: str) -> float:
        """
        Поглощение: ОИ растёт, цена не двигается.
        >0 — шорты поглощаются (бычий потенциал выброса вверх).
        <0 — лонги поглощаются (медвежий потенциал выброса вниз).
        """
        return self._scores.get(ticker, {}).get("absorption", 0.0)
