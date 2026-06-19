"""
Группировка тикеров по эмитенту + отсев "слабых" дублей.

Зачем: бэктест/портфельная симуляция в dashboard.py считают каждый тикер
независимо, как будто это разные ставки — но обычка+префы одного
эмитента (или акция+фьючерс на неё) по факту сильно коррелированы, это
один и тот же риск, посчитанный дважды. Чтобы прогон отражал реальность
(а не "торгуем 38 бумаг", когда по факту это 15 эмитентов), внутри
каждой группы эмитента оставляем только самый востребованный тикер,
а из выживших — top_pct % самых востребованных.

Используется и dashboard.py (бэктест/портфель), и (при появлении
OI-тикеров в живой торговле) ботом — общая логика, единое место правки.
"""
import re

# Суффиксы, которыми на MOEX обычно отличают вторую бумагу того же
# эмитента (привилегированные акции) — отрезаем, чтобы "Сбербанк" и
# "Сбербанк-п" схлопнулись в один issuer_key.
_PREFERRED_SUFFIX_RE = re.compile(
    r"[\s\-]*(привилегированн\w*|преф\w*)\s*$", re.IGNORECASE
)


def issuer_key(ticker: str, name: str = "", basic_asset: str = "") -> str:
    """
    Ключ эмитента для дедупликации:
    - у фьючерсов есть basic_asset (базовый актив) прямо от биржи — берём его;
    - у акций — нормализованное имя компании без хвоста "...привилегированные";
    - если имени нет — тикер без хвостовой "P" (типовой MOEX-нейминг префов,
      напр. SBERP -> SBER).
    """
    if basic_asset:
        return basic_asset.strip().upper()
    if name:
        key = _PREFERRED_SUFFIX_RE.sub("", name.strip().lower())
        return re.sub(r"\s+", " ", key).strip()
    return re.sub(r"P$", "", ticker.upper())


def select_top_tickers(infos: list[dict], top_pct: float = 0.7) -> tuple[list[str], list[dict]]:
    """
    infos: [{"ticker", "issuer_key", "demand"}].

    1) Внутри каждой группы issuer_key оставляет только тикер с максимальным
       demand (остальные — "тот же базис, слабее").
    2) Из выживших оставляет top_pct по demand (минимум 1 тикер).

    Возвращает (kept_tickers, dropped) — dropped с причиной для UI.
    """
    if not infos:
        return [], []

    best_by_issuer: dict[str, dict] = {}
    dropped: list[dict] = []
    for info in infos:
        key = info["issuer_key"]
        cur = best_by_issuer.get(key)
        if cur is None:
            best_by_issuer[key] = info
        elif info["demand"] > cur["demand"]:
            dropped.append({"ticker": cur["ticker"], "reason": f"тот же эмитент, что {info['ticker']} (слабее)"})
            best_by_issuer[key] = info
        else:
            dropped.append({"ticker": info["ticker"], "reason": f"тот же эмитент, что {cur['ticker']} (слабее)"})

    survivors = sorted(best_by_issuer.values(), key=lambda i: i["demand"], reverse=True)
    keep_n = max(1, round(len(survivors) * top_pct))
    kept, rest = survivors[:keep_n], survivors[keep_n:]
    dropped.extend({"ticker": i["ticker"], "reason": f"не входит в топ-{round(top_pct * 100)}% по востребованности"}
                   for i in rest)

    return [i["ticker"] for i in kept], dropped
