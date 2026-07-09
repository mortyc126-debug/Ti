"""tpcolor_predict.py — предсказательная сила признаков T/P/color.

corr_all.csv проверял только ВЗАИМНУЮ независимость осей (T̂↔P̂↔color̂). Здесь
второй, главный вопрос: предсказывает ли каждый признак будущее движение.

Читает по-баровый CSV, который tpcolor_dataset пишет в --out (один тикер) или
в --per-ticker-dir (папка на тикер), пулит строки и по каждому признаку считает:
  - IC_dir — Spearman(признак, fwd_ret_k): направленная сила (знак важен);
  - IC_mag — Spearman(признак, |fwd_ret_k|): предсказывает ли РАЗМАХ хода
             (для T это главное — интенсивность направления не несёт);
  - hit%   — доля, где знак признака совпал со знаком движения;
  - квинтили признака → среднее fwd_ret_k, размах Q5-Q1 и тренд.
fwd_ret_k уже нормирован на ATR (bar-native) — тикеры пулятся без поправок.

Запуск (из invest-bot/), сначала собрав по-баровые CSV:
    python tpcolor_dataset.py ALL --all --per-ticker-dir out/per_ticker
    python tpcolor_predict.py out/per_ticker           # папка
    python tpcolor_predict.py sber_tpc.csv             # один файл
"""
import argparse
import csv
import glob
import math
import os

FEATURES = ("T_hat", "P_hat", "color_hat", "T_macro_hat", "P_macro_hat")


def _num(x):
    if x is None or x == "" or x == "None":
        return None
    try:
        return float(x)
    except ValueError:
        return None


def _load(paths: list) -> tuple[list, list]:
    rows = []
    present = []
    for p in paths:
        with open(p, newline="", encoding="utf-8") as f:
            rd = csv.DictReader(f)
            if not present and rd.fieldnames:
                present = [c for c in FEATURES if c in rd.fieldnames]
            for r in rd:
                if r.get("outcome_known") != "1":
                    continue
                fr = _num(r.get("fwd_ret_k"))
                if fr is None:
                    continue
                rec = {"fwd": fr}
                for feat in present:
                    rec[feat] = _num(r.get(feat))
                rows.append(rec)
    return rows, present


def _ranks(xs: list) -> list:
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
    if n < 30:
        return None
    rx, ry = _ranks(xs), _ranks(ys)
    mx, my = sum(rx) / n, sum(ry) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    vx = sum((a - mx) ** 2 for a in rx)
    vy = sum((b - my) ** 2 for b in ry)
    if vx <= 0 or vy <= 0:
        return 0.0
    return cov / math.sqrt(vx * vy)


def _summary(rows: list, present: list) -> None:
    print(f"\n=== Предсказательная сила T/P/color ({len(rows)} баров) ===")
    print("IC_dir — Spearman(признак, fwd_ret); IC_mag — Spearman(признак, |fwd_ret|); "
          "hit — совпадение знака\n")
    print(f"{'признак':<14}{'N':>8}{'IC_dir':>9}{'IC_mag':>9}{'hit%':>8}")
    for feat in present:
        pairs = [(r[feat], r["fwd"]) for r in rows if r.get(feat) is not None]
        n = len(pairs)
        if n < 30:
            print(f"{feat:<14}{n:>8}{'—':>9}{'—':>9}{'—':>8}")
            continue
        xs = [a for a, _ in pairs]
        ys = [b for _, b in pairs]
        icd = _spearman(xs, ys)
        icm = _spearman(xs, [abs(b) for b in ys])
        nz = [(a, b) for a, b in pairs if a != 0 and b != 0]
        hit = 100 * sum(1 for a, b in nz if a * b > 0) / len(nz) if nz else 0.0
        icd_s = f"{icd:+.3f}" if icd is not None else "—"
        icm_s = f"{icm:+.3f}" if icm is not None else "—"
        print(f"{feat:<14}{n:>8}{icd_s:>9}{icm_s:>9}{hit:>8.1f}")

    print("\n-- квинтили признака → среднее fwd_ret_k (bar-native ATR) --")
    print(f"{'признак':<14}{'Q1':>9}{'Q2':>9}{'Q3':>9}{'Q4':>9}{'Q5':>9}{'Q5-Q1':>9}{'тренд':>7}")
    for feat in present:
        vals = [(r[feat], r["fwd"]) for r in rows if r.get(feat) is not None]
        if len(vals) < 50:
            print(f"{feat:<14}{'мало данных':>40}")
            continue
        vals.sort(key=lambda t: t[0])
        n = len(vals)
        qs = [sum(b for _, b in vals[q * n // 5:(q + 1) * n // 5])
              / max(1, len(vals[q * n // 5:(q + 1) * n // 5])) for q in range(5)]
        ups = sum(1 for a, b in zip(qs, qs[1:]) if b > a)
        trend = "↑" if ups >= 3 else ("↓" if ups <= 1 else "смеш")
        print(f"{feat:<14}" + "".join(f"{v:>9.4f}" for v in qs)
              + f"{qs[-1]-qs[0]:>+9.4f}{trend:>7}")


def main() -> None:
    ap = argparse.ArgumentParser(description="IC/hit-rate признаков T/P/color против будущего движения")
    ap.add_argument("path", help="по-баровый CSV или папка с CSV (из --per-ticker-dir)")
    ap.add_argument("--glob", default="*.csv", help="маска файлов, если path — папка")
    args = ap.parse_args()

    if os.path.isdir(args.path):
        paths = sorted(glob.glob(os.path.join(args.path, args.glob)))
    else:
        paths = [args.path]
    if not paths:
        raise SystemExit(f"нет CSV по пути {args.path}")

    rows, present = _load(paths)
    if not rows:
        raise SystemExit("нет валидных строк (нужны колонки T_hat/P_hat/color_hat/fwd_ret_k, "
                         "outcome_known=1). Это по-баровый CSV, не corr_all.csv?")
    print(f"файлов: {len(paths)}, признаков: {present}")
    _summary(rows, present)


if __name__ == "__main__":
    main()
