"""oi_signal_dataset.py — аудит направленной точности OI-методов.

Вопрос: насколько верно каждый OI-метод бота (inst_oi, retail_contra,
delta_quadrant, absorption, squeeze) определяет НАПРАВЛЕНИЕ будущего движения —
и какой из них реально работает, а какой балласт (сейчас вес им подбирает Hedge
вслепую, standalone-точность не мерил никто, как было с index_context).

Полностью офлайн: и скоры, и цены берутся из data/oi_daily.json через
OiBacktestProvider (строки только tradedate <= дата → без подглядывания). Сеть и
токены не нужны. OI дневной, поэтому и горизонты возврата дневные (1/2/3 дня).

Метрики на каждый метод × горизонт:
  - IC   — ранговая корреляция (Spearman) скор ↔ нормированный forward-return.
           Знак важен: IC<0 значит метод предсказывает направление НАОБОРОТ.
  - hit% — доля дней, где знак скора совпал со знаком будущего движения.
  - E    — направленная отдача: среднее sign(скор)×возврат (в единицах дневной
           волатильности тикера, кросс-тикерно сопоставимо) за вычетом издержек.
Плюс монотонность по квинтилям скора (растёт ли возврат от Q1 к Q5) — прямой
глаз на «определяет ли направление».

Запуск (из invest-bot/):
    python oi_signal_dataset.py [--tickers SBER,GAZP] [--horizons 1,2,3]
                                [--cost 0.0] [--oi data/oi_daily.json]
"""
import argparse
import json
import logging
import math
import os

from oi_layers import OiBacktestProvider, HISTORY_FILE

logger = logging.getLogger(__name__)

METHODS = ("inst_oi", "retail_contra", "delta_quadrant", "absorption", "squeeze_signed")


def _method_scores(prov, ticker: str) -> dict:
    """Знаковые скоры методов на текущей дате провайдера. squeeze сводим в один
    знаковый: up (шорты зажаты → вверх) минус down."""
    return {
        "inst_oi": prov.inst_oi_score(ticker),
        "retail_contra": prov.retail_contra_score(ticker),
        "delta_quadrant": prov.delta_quadrant_score(ticker),
        "absorption": prov.absorption_score(ticker),
        "squeeze_signed": prov.squeeze_score(ticker, "short") - prov.squeeze_score(ticker, "long"),
    }


def _price_series(rows: list) -> tuple[list, list]:
    """Хронологический ряд (даты, цены) по одной цене на дату (последняя за день)."""
    by_date: dict = {}
    for r in rows:
        d = str(r.get("tradedate") or "")
        p = r.get("price")
        if d and p:
            by_date[d] = float(p)
    dates = sorted(by_date)
    return dates, [by_date[d] for d in dates]


def _ranks(xs: list) -> list:
    """Средние ранги (1-based), корректная обработка совпадений."""
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    r = [0.0] * len(xs)
    i = 0
    while i < len(xs):
        j = i
        while j + 1 < len(xs) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            r[order[k]] = avg
        i = j + 1
    return r


def _spearman(xs: list, ys: list):
    n = len(xs)
    if n < 20:
        return None
    rx, ry = _ranks(xs), _ranks(ys)
    mx, my = sum(rx) / n, sum(ry) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    vx = sum((a - mx) ** 2 for a in rx)
    vy = sum((b - my) ** 2 for b in ry)
    if vx <= 0 or vy <= 0:
        return 0.0
    return cov / math.sqrt(vx * vy)


def collect(hist: dict, horizons: list, tickers: list | None = None) -> list:
    """Одна запись на (тикер, дата): скоры всех методов + нормированные
    forward-return по горизонтам. Нормировка на дневную волатильность тикера —
    чтобы пулить спокойные и резвые бумаги вместе."""
    prov = OiBacktestProvider(hist)
    hmax = max(horizons)
    out = []
    for ticker, rows in hist.items():
        if tickers and ticker not in tickers:
            continue
        dates, prices = _price_series(rows)
        if len(dates) < hmax + 25:
            continue
        rets = [(prices[k] - prices[k - 1]) / prices[k - 1] for k in range(1, len(prices))]
        sigma = (sum(r * r for r in rets) / len(rets)) ** 0.5 if rets else 0.0
        if sigma <= 0:
            continue
        for i in range(len(dates) - hmax):
            prov.set_date(dates[i])
            sc = _method_scores(prov, ticker)
            if all(abs(v) < 1e-9 for v in sc.values()):
                continue  # день без OI-сигнала вообще — не мусорим выборку
            rec = {"ticker": ticker, "date": dates[i], **sc}
            for h in horizons:
                rec[f"fwd{h}"] = ((prices[i + h] - prices[i]) / prices[i]) / sigma
            out.append(rec)
    return out


def _summary(records: list, horizons: list, cost: float) -> None:
    print(f"\n=== Аудит направленной точности OI ({len(records)} тикер-дней) ===")
    print("IC — ранговая корр. скор↔возврат (знак важен); hit — совпадение знака; "
          "E — sign(скор)×возврат в дневных σ за вычетом издержек\n")

    for h in horizons:
        key = f"fwd{h}"
        print(f"-- горизонт {h} дн --")
        print(f"{'метод':<16}{'N':>7}{'IC':>8}{'hit%':>8}{'E(σ)':>9}")
        for m in METHODS:
            pairs = [(r[m], r[key]) for r in records if abs(r[m]) > 1e-9]
            n = len(pairs)
            if n < 20:
                print(f"{m:<16}{n:>7}{'—':>8}{'—':>8}{'—':>9}")
                continue
            xs = [a for a, _ in pairs]
            ys = [b for _, b in pairs]
            ic = _spearman(xs, ys)
            hit = 100 * sum(1 for a, b in pairs if a * b > 0) / n
            e = sum((1 if a > 0 else -1) * b for a, b in pairs) / n - cost
            ic_s = f"{ic:+.3f}" if ic is not None else "—"
            print(f"{m:<16}{n:>7}{ic_s:>8}{hit:>8.1f}{e:>+9.3f}")
        print()

    # Монотонность по квинтилям скора на горизонте 1 — «определяет ли направление».
    h = horizons[0]
    key = f"fwd{h}"
    print(f"-- монотонность по квинтилям скора (горизонт {h} дн, среднее возврата в σ) --")
    print(f"{'метод':<16}{'Q1(low)':>9}{'Q2':>9}{'Q3':>9}{'Q4':>9}{'Q5(high)':>10}{'Q5-Q1':>9}{'  тренд':>8}")
    for m in METHODS:
        vals = [(r[m], r[key]) for r in records if abs(r[m]) > 1e-9]
        if len(vals) < 50:
            print(f"{m:<16}{'мало данных':>46}")
            continue
        vals.sort(key=lambda t: t[0])
        n = len(vals)
        qs = []
        for q in range(5):
            seg = vals[q * n // 5:(q + 1) * n // 5]
            qs.append(sum(b for _, b in seg) / len(seg) if seg else 0.0)
        # Тренд по большинству шагов (терпим один разворот): ≥3 из 4 в одну сторону.
        ups = sum(1 for a, b in zip(qs, qs[1:]) if b > a)
        trend = "↑" if ups >= 3 else ("↓" if ups <= 1 else "смеш")
        print(f"{m:<16}" + "".join(f"{v:>9.3f}" if i < 4 else f"{v:>10.3f}"
                                   for i, v in enumerate(qs))
              + f"{qs[-1]-qs[0]:>+9.3f}{trend:>8}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Аудит направленной точности OI-методов (офлайн, oi_daily.json)")
    parser.add_argument("--oi", default=HISTORY_FILE)
    parser.add_argument("--tickers", default="")
    parser.add_argument("--horizons", default="1,2,3")
    parser.add_argument("--cost", type=float, default=0.0, help="издержки на круг в дневных σ")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if not os.path.exists(args.oi):
        raise SystemExit(f"нет файла {args.oi} — сначала накопи OI (backfill_oi.py) или запусти бота")
    with open(args.oi, encoding="utf-8") as f:
        hist = json.load(f)

    tickers = [t.strip() for t in args.tickers.split(",") if t.strip()] or None
    horizons = [int(x) for x in args.horizons.split(",")]

    records = collect(hist, horizons, tickers)
    logger.info("тикеров в OI: %d, собрано тикер-дней: %d", len(hist), len(records))
    if not records:
        raise SystemExit("нет данных: в oi_daily.json мало истории или нет поля price")

    out_path = os.path.join("data", "analysis", "oi_signal_dataset.csv")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    cols = ["ticker", "date"] + list(METHODS) + [f"fwd{h}" for h in horizons]
    import csv
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for r in records:
            w.writerow({k: r.get(k) for k in cols})
    print(f"CSV: {out_path} ({len(records)} строк)")

    _summary(records, horizons, args.cost)


if __name__ == "__main__":
    main()
