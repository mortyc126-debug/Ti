"""elite_preset_validate.py — OOS-валидация пресетов уведомлений
tv-signals-extension (all/often/mid/strict/elite, см. NOTIFY_PRESETS в
tv-signals-extension/content.js) на реальной истории из data/candle_cache.

Зачем. Расширение считает exp/acc метода НА ВСЕЙ доступной истории тикера и
тут же использует эту же цифру, чтобы решить, достоин ли сигнал уведомления
(notifyCheckMethods: st.exp > minExp, st.acc*100 >= minWin, st.n >= 10 —
пороги пресета exp/win, см. NOTIFY_PRESETS). Это оценка "в себя" (in-sample):
неизвестно, держится ли ярлык "элитно" на будущих барах или это переобучение
на короткой истории конкретного тикера. Здесь — честная OOS-проверка:

  - train = первые --split (default 0.6) баров тикера, test = остаток;
  - на train по каждому (тикер, метод) считаем bt_stats — порт btStats из
    tv-signals-extension/signals-core.js (тейк 1.5 / стоп 0.75 ATR, cost
    0.12, без перекрытия — те же цифры, что в system_backtest.py) →
    exp_train/acc_train/n_train;
  - по этим цифрам и порогам NOTIFY_PRESETS решаем, до какого пресета
    "дорос" ярлык пары (самый строгий, которому она удовлетворяет);
  - на test прогоняем ТОТ ЖЕ bt_stats и складываем сделки в корзину своего
    пресета — кумулятивно (elite ⊆ strict ⊆ mid ⊆ often ⊆ all, пороги
    NOTIFY_PRESETS монотонно растут по exp и win);
  - печатаем: пресет → пар (тикер×метод) → сделок OOS → win% → exp ATR.

Методы — РОВНО те же 32, что в самом расширении (включая ema200_revert —
возврат к EMA200 после долгого отрыва). Сигналы считает не Python-порт, а
сам tv-signals-extension/signals-core.js через run_signals_core.js (Node —
чистый модуль, без DOM, требует только --window/global — см. его шапку).
Так формулы гарантированно не расходятся с тем, что реально видит
пользователь в терминале. Нужен node в PATH (--node, если он не в PATH).

Прерывание/продолжение: прогресс (пройденные тикеры + накопленные корзины)
пишется в --checkpoint (data/elite_preset_checkpoint.json по умолчанию)
атомарно после КАЖДОГО тикера. Ctrl+C — печатает отчёт по тому, что успело
посчитаться, и выходит; повторный запуск С ТЕМИ ЖЕ аргументами продолжает с
первого непройденного тикера (сигнатура аргументов проверяется — при
изменении --split/--horizon/--days/тикеров и т.п. чекпоинт игнорируется,
печатается предупреждение). --fresh игнорирует и перезаписывает чекпоинт.

ATR-фильтр шума: вход в сделку только если ATR/цена >= комиссия_за_круг ×
--min-atr-factor (по умолчанию — тот же MIN_ATR_FACTOR=1.5, что уже стоит в
живом боте, trade_system/strategies/oi_composite_strategy.py). Без него
btStats пропускал вход при ЛЮБОМ atr>0 — на тикерах/периодах с почти
нулевой волатильностью тейк/стоп оказывались теснее реальных издержек
(спред+комиссия), и такие "сделки" технически исполнялись в бэктесте, хотя
в жизни съедались бы костом. --min-atr-factor 0 выключает фильтр (старое
поведение) — удобно прогнать оба варианта и сравнить, насколько цифры
раньше были раздуты шумовыми входами.

Нужен непустой data/candle_cache (заполняется prefetch_candles.py /
prefetch_top_liq.py на боевой машине с сетью — здесь его в чистом клоне
нет). Запуск:
  python elite_preset_validate.py ALL --top-liq 50 --days 180
  python elite_preset_validate.py GAZP,SBER,LKOH --split 0.6 --out out.csv
  python elite_preset_validate.py ALL --top-liq 50 --days 180 --min-atr-factor 0  # без ATR-фильтра, для сравнения
  # Ctrl+C посреди прогона, затем тот же вызов ещё раз — продолжит с места остановки.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
try:
    import tinkoff.invest  # noqa: F401
except ImportError:
    _stub = os.path.join(_HERE, "_tinkoff_stub")
    if _stub not in sys.path:
        sys.path.insert(0, _stub)

import score_methods as _sm  # noqa: E402
from score_methods import _load_from_cache, _list_tickers  # noqa: E402
from atomic_json import atomic_write_json  # noqa: E402

# _atr_sma читает numpy из module-global _WORKER_NP, который score_methods
# заполняет только внутри _init_worker() (обычно на каждый mp.Pool-воркер).
# Мы однопроцессные — вызываем его руками один раз, иначе _WORKER_NP=None
# и _atr_sma падает на np.full_like(None, ...).
_sm._init_worker()
from score_methods import _atr_sma  # noqa: E402
from trade_system.strategies.oi_composite_strategy import commission_rt, MIN_ATR_FACTOR  # noqa: E402

NODE_BRIDGE = os.path.join(_HERE, "run_signals_core.js")

# Грубый, но рабочий детект фьючерса по тикеру: 1-4 буквы + код месяца
# (FGHJKMNQUVXZ) + цифра года (SiU6, BTM6, VKU6, ...). Акции/облигации под
# него не попадают (SBER, GAZP, VTBR, ...). Нужен только чтобы взять верную
# ставку комиссии для ATR-фильтра — не для реальной торговли.
_FUT_RE = re.compile(r"^[A-Z]{1,4}[FGHJKMNQUVXZ]\d$")


def _is_future(ticker: str) -> bool:
    return bool(_FUT_RE.match(ticker.upper()))

# Та же таблица, что NOTIFY_PRESETS в tv-signals-extension/content.js — держать
# в синхроне при правке одного из файлов. (key, min_exp ATR, min_win %)
PRESETS = [
    ("all", 0.0, 0),
    ("often", 0.03, 0),
    ("mid", 0.05, 55),
    ("strict", 0.10, 60),
    ("elite", 0.15, 65),
]
MIN_N = 10  # как в notifyCheckMethods: st.n < 10 → сигнал не считается


def bt_stats(scores, closes, highs, lows, atr, horizon=12, take=1.5, stop=0.75, cost=0.12,
             min_atr_pct=0.0):
    """Порт btStats() из tv-signals-extension/signals-core.js. scores[i] — сырой
    скор метода на баре i (0/None = сигнала нет). Возвращает {acc, exp, win, n}
    ровно как в JS-версии: acc — доля совпадений знака с ходом через horizon
    баров; exp/win/n — бар-за-баром сделки тейк/стоп, одна позиция, без
    перекрытия, тайм-выход через horizon баров.

    min_atr_pct — ТОТ ЖЕ ATR-фильтр шума, что уже есть в живом боте
    (oi_composite_strategy.MIN_ATR_FACTOR: ATR должен покрывать комиссию за
    круг с запасом, иначе тейк/стоп теснее реальных издержек — "сделка" в
    бэктесте технически исполнима, а в жизни съедается спредом/комиссией).
    Ни у btStats в signals-core.js, ни здесь раньше такого пола не было —
    только atr>0. 0.0 = фильтр выключен (как раньше)."""
    n = len(closes)
    hit = hn = 0
    for i in range(n - horizon):
        sc = scores[i]
        if not sc:
            continue
        fut = closes[i + horizon] - closes[i]
        if fut == 0:
            continue
        hn += 1
        if (sc > 0 and fut > 0) or (sc < 0 and fut < 0):
            hit += 1
    pnl_sum = 0.0
    wins = 0
    tn = 0
    pos = None
    for i in range(n):
        hi, lo, cl = highs[i], lows[i], closes[i]
        if pos is not None:
            ex = None
            if pos["dir"] > 0:
                if lo <= pos["sl"]:
                    ex = pos["sl"]
                elif hi >= pos["tp"]:
                    ex = pos["tp"]
            else:
                if hi >= pos["sl"]:
                    ex = pos["sl"]
                elif lo <= pos["tp"]:
                    ex = pos["tp"]
            if ex is None and i - pos["i"] >= horizon:
                ex = cl
            if ex is not None:
                p = pos["dir"] * (ex - pos["entry"]) / pos["eatr"] - cost
                pnl_sum += p
                if p > 0:
                    wins += 1
                tn += 1
                pos = None
        if pos is None:
            sc = scores[i]
            e = atr[i]
            if sc and e and e > 0 and not math.isnan(e) and (not min_atr_pct or e / cl >= min_atr_pct):
                d = 1 if sc > 0 else -1
                pos = {"dir": d, "entry": cl, "tp": cl + d * take * e, "sl": cl - d * stop * e, "eatr": e, "i": i}
    return {
        "acc": (hit / hn) if hn else None,
        "exp": (pnl_sum / tn) if tn else None,
        "win": (wins / tn) if tn else None,
        "n": tn,
    }


def clears(stats, min_exp, min_win):
    """Точная копия условия notifyCheckMethods: exp строго > порога (не >=),
    win — только если порог > 0 (в 'all'/'often' win=0 = проверка не идёт)."""
    if stats["n"] < MIN_N or stats["exp"] is None:
        return False
    if not (stats["exp"] > min_exp):
        return False
    if min_win > 0:
        if stats["acc"] is None or stats["acc"] * 100 < min_win:
            return False
    return True


def tier_of(stats):
    """Индекс самого строгого пресета из PRESETS, которому пара удовлетворяет
    (-1 = не проходит даже 'all'). Пороги монотонно растут по exp и win, так
    что "самый строгий пройденный" эквивалентно "проходит все более мягкие"."""
    idx = -1
    for i, (_key, min_exp, min_win) in enumerate(PRESETS):
        if clears(stats, min_exp, min_win):
            idx = i
    return idx


def node_scores(rows_raw, node_bin, horizon):
    """Вызывает run_signals_core.js → {methodId: [score|null,...]} — сигналы
    ВСЕХ 32 методов signals-core.js, той же формулой, что живое расширение."""
    p = subprocess.run(
        [node_bin, NODE_BRIDGE, str(horizon)],
        input=json.dumps(rows_raw), capture_output=True, text=True,
    )
    if p.returncode != 0:
        raise RuntimeError(f"node упал: {p.stderr[-2000:]}")
    return json.loads(p.stdout)


def process_ticker(ticker, cache_dir, interval, days, split_frac, horizon,
                    methods_filter, n_atr, node_bin, min_atr_factor, invert_set=None):
    rows_raw = _load_from_cache(ticker, cache_dir, interval)
    if not rows_raw:
        return None
    if days:
        rows_raw = rows_raw[-max(days * (390 // max(interval, 1)), 250):]
    if len(rows_raw) < 250 + horizon:
        return None
    closes = [r["close"] for r in rows_raw]
    highs = [r["high"] for r in rows_raw]
    lows = [r["low"] for r in rows_raw]
    import numpy as np
    atr = _atr_sma(np.array(highs, dtype=float), np.array(lows, dtype=float), n_atr).tolist()
    n = len(closes)
    split_idx = int(n * split_frac)
    if split_idx < 200 or n - split_idx < horizon + 10:
        return None
    min_atr_pct = commission_rt(_is_future(ticker)) * min_atr_factor if min_atr_factor else 0.0

    all_scores = node_scores(rows_raw, node_bin, horizon)
    out = {}
    for name, scores in all_scores.items():
        if methods_filter and name not in methods_filter:
            continue
        if invert_set and name in invert_set:
            scores = [-s if s else s for s in scores]  # 0/None не трогаем — "нет сигнала" не инвертируется
        train = bt_stats(scores[:split_idx], closes[:split_idx], highs[:split_idx], lows[:split_idx],
                          atr[:split_idx], horizon=horizon, min_atr_pct=min_atr_pct)
        test = bt_stats(scores[split_idx:], closes[split_idx:], highs[split_idx:], lows[split_idx:],
                         atr[split_idx:], horizon=horizon, min_atr_pct=min_atr_pct)
        out[name] = (train, test)
    return out


def _run_sig(args, tickers):
    """Хэш параметров, влияющих на сравнимость прогонов — чекпоинт от другой
    конфигурации (иной сплит/горизонт/набор тикеров) резюмировать нельзя."""
    payload = {
        "tickers": sorted(tickers), "interval": args.interval, "days": args.days,
        "split": args.split, "horizon": args.horizon, "n_atr": args.n_atr,
        "min_atr_factor": args.min_atr_factor,
        "methods": sorted(args.methods.lower().split(",")) if args.methods else None,
        "invert": sorted(args.invert.lower().split(",")) if args.invert else None,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


def _load_checkpoint(path, sig):
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            cp = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None
    if cp.get("sig") != sig:
        print(f"[checkpoint] {path} — другая конфигурация прогона, игнорирую (--fresh чтобы убрать предупреждение)",
              file=sys.stderr)
        return None
    return cp


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tickers", help="тикер, список через запятую, или ALL")
    ap.add_argument("--cache", default=os.path.join(_HERE, "data", "candle_cache"))
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--split", type=float, default=0.6, help="доля train (grading), остальное — OOS test")
    ap.add_argument("--horizon", type=int, default=12)
    ap.add_argument("--n-atr", type=int, default=20)
    ap.add_argument("--min-atr-factor", type=float, default=MIN_ATR_FACTOR,
                     help=f"ATR-фильтр шума: вход только если ATR/цена >= комиссия_за_круг × этот "
                          f"фактор (как в живом боте, MIN_ATR_FACTOR={MIN_ATR_FACTOR}). 0 — выключить фильтр")
    ap.add_argument("--top-liq", type=int, default=None, help="топ-N по ликвидности (только tickers=ALL)")
    ap.add_argument("--methods", default=None,
                     help="подмножество id из signals-core.js IDS через запятую (напр. ema200_revert,zscore,nw)")
    ap.add_argument("--invert", default=None,
                     help="id методов через запятую, чей скор инвертировать перед bt_stats (проверить "
                          "'работает наоборот' не трогая сам метод в расширении)")
    ap.add_argument("--node", default="node", help="путь к node, если не в PATH")
    ap.add_argument("--out", default=None, help="CSV по парам (тикер,метод,tier,train/test stats)")
    ap.add_argument("--checkpoint", default=os.path.join(_HERE, "data", "elite_preset_checkpoint.json"))
    ap.add_argument("--fresh", action="store_true", help="игнорировать существующий чекпоинт, начать с нуля")
    args = ap.parse_args()

    methods_filter = {m.strip().lower() for m in args.methods.split(",")} if args.methods else None
    invert_set = {m.strip().lower() for m in args.invert.split(",")} if args.invert else None

    if args.tickers.upper() == "ALL":
        tickers = _list_tickers(args.cache, args.interval, top_liq=args.top_liq, liq_days=60,
                                 min_vol_pctl=0.0, max_vol_pctl=100.0, workers=1)
    else:
        tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    if not tickers:
        sys.exit("нет тикеров (пуст data/candle_cache? см. prefetch_candles.py)")

    sig = _run_sig(args, tickers)
    cp = None if args.fresh else _load_checkpoint(args.checkpoint, sig)

    buckets = {i: [0.0, 0, 0] for i in range(len(PRESETS))}  # tier -> [pnl_sum, wins, n] на OOS
    pairs_rows = []
    done_set = set()
    if cp:
        for i in range(len(PRESETS)):
            b = cp["buckets"].get(str(i))
            if b:
                buckets[i] = b
        pairs_rows = [tuple(r) for r in cp.get("pairs_rows", [])]
        done_set = set(cp.get("done_tickers", []))
        print(f"[checkpoint] продолжаю: {len(done_set)}/{len(tickers)} тикеров уже готовы", file=sys.stderr)

    remaining = [t for t in tickers if t not in done_set]
    already_done = len(done_set)
    interrupted = False
    try:
        for i, t in enumerate(remaining):
            try:
                res = process_ticker(t, args.cache, args.interval, args.days, args.split,
                                      args.horizon, methods_filter, args.n_atr, args.node,
                                      args.min_atr_factor, invert_set)
            except RuntimeError as e:
                print(f"\n[{t}] {e}", file=sys.stderr)
                res = None
            print(f"\r{already_done + i + 1}/{len(tickers)} {t:<12}", end="", file=sys.stderr, flush=True)
            if res:
                for name, (train, test) in res.items():
                    tier = tier_of(train)
                    if tier < 0:
                        continue
                    b = buckets[tier]
                    if test["n"]:
                        b[0] += test["exp"] * test["n"]
                        b[1] += test["win"] * test["n"]
                        b[2] += test["n"]
                    pairs_rows.append((t, name, PRESETS[tier][0],
                                        train["exp"], train["acc"], train["n"],
                                        test["exp"], test["win"], test["n"]))
            done_set.add(t)
            atomic_write_json(args.checkpoint, {
                "sig": sig, "done_tickers": sorted(done_set),
                "buckets": {str(k): v for k, v in buckets.items()},
                "pairs_rows": pairs_rows,
            })
    except KeyboardInterrupt:
        interrupted = True
    print(file=sys.stderr)
    if interrupted:
        print(f"[прервано] {len(done_set)}/{len(tickers)} тикеров готово, прогресс сохранён в {args.checkpoint}. "
              f"Запусти команду ещё раз с теми же аргументами, чтобы продолжить.", file=sys.stderr)

    if args.out:
        with open(args.out, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["ticker", "method", "train_tier", "train_exp", "train_acc", "train_n",
                        "test_exp", "test_win", "test_n"])
            w.writerows(pairs_rows)
        print(f"пары записаны в {args.out}", file=sys.stderr)

    print(f"\n{'пресет':<8} {'пар (train)':>12} {'сделок OOS':>11} {'win% OOS':>9} {'exp ATR OOS':>12}")
    n_pairs_at_or_above = [0] * len(PRESETS)
    for _, _, tier_key, *_ in pairs_rows:
        idx = next(i for i, p in enumerate(PRESETS) if p[0] == tier_key)
        for j in range(idx + 1):
            n_pairs_at_or_above[j] += 1
    for i, (key, _min_exp, _min_win) in enumerate(PRESETS):
        pnl = wins = cnt = 0.0
        for j in range(i, len(PRESETS)):
            pnl += buckets[j][0]
            wins += buckets[j][1]
            cnt += buckets[j][2]
        win_pct = (wins / cnt * 100) if cnt else float("nan")
        exp = (pnl / cnt) if cnt else float("nan")
        print(f"{key:<8} {n_pairs_at_or_above[i]:>12} {int(cnt):>11} {win_pct:>8.1f}% {exp:>+11.3f}")

    if not interrupted:
        print(f"\n[готово] чтобы посчитать с нуля в другой раз: --fresh (или удали {args.checkpoint})",
              file=sys.stderr)


if __name__ == "__main__":
    main()
