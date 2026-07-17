"""
nw_memory_xtkr.py — кросс-тикерная NW-память с жёстким фильтром совпадения.

Идея (пользователь): вместо памяти по ОДНОМУ тикеру — единый банк аналогов по
ВСЕМ тикерам, но с ЖЁСТКИМ порогом близости (радиусом). Там, где у одного тикера
«нет прецедента», глобальный банк даёт много ТОЧНЫХ аналогов.

Скрипт считает три режима ОДНОЙ И ТОЙ ЖЕ метрикой (чтобы сравнивать честно):
  (по умолчанию)  глобальный банк (все тикеры) + жёсткий радиус;
  --cross-only    глобальный банк МИНУС тот же тикер (чистый кросс-тикер);
  --local         только аналоги того же тикера (базлайн ≈ текущая NW-память).

ЧЕСТНОСТЬ (анти-лукахед): аналог j годится для запроса i, только если его исход
реализовался ДО времени i по АБСОЛЮТНОМУ времени:  time(j) + k*bar ≤ time(i).
Иначе глобальный банк «видит будущее» других тикеров. Это не опция — всегда.

Вход: каталог с *_tpc.csv (из tpcolor_dataset.py ALL --all --per-ticker-dir DIR),
в каждом колонки: time, T_hat, P_hat, color_hat, fwd_ret_k, target, outcome_known.

Запуск (сравнение):
    py -3.11 nw_memory_xtkr.py out/per_ticker --radius 0.25            # глобально-жёсткая
    py -3.11 nw_memory_xtkr.py out/per_ticker --radius 0.25 --cross-only
    py -3.11 nw_memory_xtkr.py out/per_ticker --radius 0.25 --local    # базлайн
    py -3.11 nw_memory_xtkr.py out/per_ticker --radius 0.25 --split-date 2026-04-01  # OOS

Метрики (все режимы): доля «с прецедентом», mean signed (edge в ATR по направлению
памяти), d (mean/std signed), hit% (угадан знак), IC (dir vs fwd_ret).
"""
import sys
import os
import csv
import glob
import argparse
from datetime import datetime

import numpy as np
from scipy.spatial import cKDTree

BAR_SECONDS = 300  # 5-мин бары; для другого ТФ поменяй --bar-min
_EPOCH = datetime(1970, 1, 1)


def _parse_time(s):
    s = (s or "").strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    # fromisoformat берёт все ISO-варианты (с таймзоной, микросекундами, T/пробел)
    try:
        return datetime.fromisoformat(s).replace(tzinfo=None)  # наивное: сравнения относительные
    except ValueError:
        pass
    s = s.replace("T", " ").split("+")[0].split(".")[0].strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _load(path):
    if os.path.isdir(path):
        files = sorted(glob.glob(os.path.join(path, "*_tpc.csv")))
        if not files:
            files = sorted(glob.glob(os.path.join(path, "*.csv")))
    else:
        files = [path]
    if not files:
        sys.exit(f"нет CSV в {path}")
    rows = []
    for fp in files:
        tk = os.path.splitext(os.path.basename(fp))[0].replace("_tpc", "").upper()
        with open(fp, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                rows.append((tk, r))
    return rows, len(files)


def _col(rows, key):
    out = np.empty(len(rows))
    for i, (_, r) in enumerate(rows):
        try:
            out[i] = float(r.get(key, ""))
        except (TypeError, ValueError):
            out[i] = np.nan
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="каталог с *_tpc.csv или один файл")
    ap.add_argument("--radius", type=float, default=0.25, help="жёсткий порог близости в 3D z-пространстве (T,P,color)")
    ap.add_argument("--k", type=int, default=12, help="горизонт fwd_ret_k")
    ap.add_argument("--min-neighbors", type=int, default=20, help="минимум аналогов после фильтров, иначе no_precedent")
    ap.add_argument("--bar-min", type=int, default=5, help="минут в баре (для анти-лукахед сдвига)")
    ap.add_argument("--cross-only", action="store_true", help="исключать аналоги того же тикера")
    ap.add_argument("--local", action="store_true", help="только аналоги того же тикера (базлайн)")
    ap.add_argument("--split-date", default=None, help="OOS: банк — только до даты, запросы — только с даты")
    ap.add_argument("--sample", type=int, default=50000, help="считать по случайной подвыборке запросов (0=все, медленно)")
    args = ap.parse_args()
    if args.cross_only and args.local:
        sys.exit("--cross-only и --local взаимоисключающие")
    bar_s = args.bar_min * 60

    rows, nfiles = _load(args.path)
    n = len(rows)
    print(f"загружено {n} строк из {nfiles} тикеров", file=sys.stderr)

    T, P, C = _col(rows, "T_hat"), _col(rows, "P_hat"), _col(rows, "color_hat")
    fwd, tgt, ok = _col(rows, "fwd_ret_k"), _col(rows, "target"), _col(rows, "outcome_known")
    tk_arr = np.array([tk for tk, _ in rows])
    # секунды от эпохи через total_seconds() — без .timestamp() (тот падает на
    # Windows на пред-эпоховых/локальных датах). Непарсящееся время → NaN.
    def _epoch_s(s):
        d = _parse_time(s)
        return (d - _EPOCH).total_seconds() if d else float("nan")
    ts = np.array([_epoch_s(r.get("time", "")) for _, r in rows])
    n_badtime = int(np.isnan(ts).sum())
    if n_badtime:
        print(f"строк с непарсящимся time (исключены): {n_badtime}", file=sys.stderr)

    split_ts = None
    if args.split_date:
        d = _parse_time(args.split_date)
        if not d:
            sys.exit("не разобрал --split-date (жду ГГГГ-ММ-ДД)")
        split_ts = (d - _EPOCH).total_seconds()

    # Банк аналогов: исход известен + валидные координаты (+ до split для OOS)
    bank = (ok == 1.0) & ~np.isnan(T) & ~np.isnan(P) & ~np.isnan(C) & ~np.isnan(tgt) & ~np.isnan(ts)
    if split_ts is not None:
        bank = bank & (ts < split_ts)
    bank_idx = np.where(bank)[0]
    if len(bank_idx) < args.min_neighbors:
        sys.exit("слишком маленький банк — ослабь фильтры/дай больше истории")
    coords = np.column_stack([T[bank_idx], P[bank_idx], C[bank_idx]])
    tree = cKDTree(coords)
    b_ts, b_tk = ts[bank_idx], tk_arr[bank_idx]
    b_y = (tgt[bank_idx] > 0).astype(float)
    print(f"банк: {len(bank_idx)} точек, KDTree dim=3", file=sys.stderr)

    # Запросы: валидные координаты (+ ≥ split для OOS)
    q = ~np.isnan(T) & ~np.isnan(P) & ~np.isnan(C) & ~np.isnan(fwd) & ~np.isnan(ts)
    if split_ts is not None:
        q = q & (ts >= split_ts)
    query_idx = np.where(q)[0]
    if args.sample and len(query_idx) > args.sample:
        query_idx = np.random.default_rng(0).choice(query_idx, args.sample, replace=False)
    print(f"запросов к оценке: {len(query_idx)}", file=sys.stderr)

    dirs, acts = [], []
    n_prec = n_noprec = 0
    for i in query_idx:
        cand = tree.query_ball_point([T[i], P[i], C[i]], r=args.radius)
        if not cand:
            n_noprec += 1
            continue
        cand = np.asarray(cand)
        m = b_ts[cand] + args.k * bar_s <= ts[i]  # анти-лукахед по абсолютному времени
        if args.cross_only:
            m = m & (b_tk[cand] != tk_arr[i])
        elif args.local:
            m = m & (b_tk[cand] == tk_arr[i])
        cand = cand[m]
        if len(cand) < args.min_neighbors:
            n_noprec += 1
            continue
        p_hold = b_y[cand].mean()
        if p_hold == 0.5:
            continue
        n_prec += 1
        dirs.append(1.0 if p_hold > 0.5 else -1.0)
        acts.append(fwd[i])

    if not dirs:
        sys.exit("ни одного прецедента — ослабь --radius / --min-neighbors")
    dirs, acts = np.array(dirs), np.array(acts)
    signed = dirs * acts
    hit = float((signed > 0).mean())
    mean = float(signed.mean())
    sd = float(signed.std(ddof=1)) if len(signed) > 1 else 0.0
    d_cohen = mean / sd if sd > 0 else float("nan")
    ic = float(np.corrcoef(dirs, acts)[0, 1]) if len(dirs) > 1 else float("nan")

    mode = "cross-only" if args.cross_only else "local" if args.local else "global"
    tag = f", OOS≥{args.split_date}" if args.split_date else ""
    print(f"\n=== NW-память [{mode}]  (radius={args.radius}, k={args.k}, min_nb={args.min_neighbors}{tag}) ===")
    print(f"запросов:           {len(query_idx)}")
    print(f"с прецедентом:      {n_prec}  ({100 * n_prec / max(1, len(query_idx)):.1f}%)")
    print(f"без прецедента:     {n_noprec}")
    print(f"mean signed (ATR):  {mean:+.4f}")
    print(f"d (mean/std):       {d_cohen:+.3f}")
    print(f"hit (знак угадан):  {100 * hit:.1f}%")
    print(f"IC (dir vs fwd):    {ic:+.3f}")
    print("\nСравни режимы global/cross-only/local по этим же цифрам:")
    print("  ждём у global больше «с прецедентом» и d/hit не хуже local;")
    print("  cross-only держит edge → паттерны универсальны между тикерами.")


if __name__ == "__main__":
    main()
