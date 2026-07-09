"""oos_compare.py — out-of-sample проверка вердиктов score_methods.

pool_regime дал роли signal/anti/noise IN-SAMPLE по всему кэшу. Прежде чем
инвертировать/отключать методы в боте, надо убедиться, что вердикт держится на
НЕВИДАННЫХ данных. Иначе это переобучение (особенно опасно — глобально
инвертировать метод по in-sample d).

OOS уже встроен в score_methods через --from/--to: гоняем его дважды на РАЗНЫХ
датах (train — раньше, test — позже), получаем два pool-CSV, этот скрипт их
сверяет по каждому методу.

    # train (без пересчёта — тот же score_methods, окно пораньше):
    python score_methods.py ALL --by-regime --from 2025-07-01 --to 2026-03-01 --pool-out pool_train.csv
    # test (окно позже):
    python score_methods.py ALL --by-regime --from 2026-03-01 --to 2026-07-08 --pool-out pool_test.csv
    # сверка:
    python oos_compare.py pool_train.csv pool_test.csv

Вердикт по методу: d агрегируется взвешенно по n_fires (мелкие режимные ячейки
сами тонут). Робастно = знак d совпал И роль та же на обоих окнах. ФЛИП знака =
переобучение, НЕ трогать в боте.
"""
import argparse
import csv


def _load(path: str, d_thresh: float) -> dict:
    """method -> (d_weighted, total_n_fires). d взвешен по n_fires по всем
    (ticker, regime) строкам метода."""
    agg: dict = {}
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            m = r.get("method")
            # score_methods --pool-out пишет колонку d_median (не d); держим оба.
            d = r.get("d_median")
            if d in ("", None):
                d = r.get("d")
            nf = r.get("n_fires")
            if not m or d in ("", None):
                continue
            try:
                d = float(d)
                w = float(nf) if nf not in ("", None) else 0.0
            except ValueError:
                continue
            if w <= 0:
                continue
            a = agg.setdefault(m, [0.0, 0.0])
            a[0] += d * w
            a[1] += w
    return {m: (dw / w, w) for m, (dw, w) in agg.items() if w > 0}


def _role(d: float, thr: float) -> str:
    return "signal" if d > thr else ("anti" if d < -thr else "noise")


def main() -> None:
    ap = argparse.ArgumentParser(description="OOS-сверка ролей методов из двух pool-CSV score_methods")
    ap.add_argument("train_csv")
    ap.add_argument("test_csv")
    ap.add_argument("--d-thresh", type=float, default=0.05, help="порог |d| для роли signal/anti")
    args = ap.parse_args()

    tr = _load(args.train_csv, args.d_thresh)
    te = _load(args.test_csv, args.d_thresh)
    methods = sorted(set(tr) | set(te))
    thr = args.d_thresh

    rows = []
    for m in methods:
        dtr, ntr = tr.get(m, (None, 0))
        dte, nte = te.get(m, (None, 0))
        if dtr is None or dte is None:
            verdict, tag = "нет в одном окне", "?"
        else:
            rtr, rte = _role(dtr, thr), _role(dte, thr)
            if rtr == rte and rtr != "noise":
                verdict, tag = f"✓ {rtr} держится", "OK"
            elif (dtr > 0) != (dte > 0) and rtr != "noise" and rte != "noise":
                verdict, tag = "✗ ФЛИП ЗНАКА — переобучение", "FLIP"
            elif rtr == "noise" and rte == "noise":
                verdict, tag = "шум на обоих", "NOISE"
            else:
                verdict, tag = f"нестабильно ({rtr}→{rte})", "WEAK"
        rows.append((tag, m, dtr, ntr, dte, nte, verdict))

    order = {"FLIP": 0, "WEAK": 1, "OK": 2, "NOISE": 3, "?": 4}
    rows.sort(key=lambda x: (order.get(x[0], 9), x[1]))

    print(f"\n=== OOS-сверка ролей ({args.train_csv} → {args.test_csv}, |d|>{thr}) ===\n")
    print(f"{'метод':<22}{'d_train':>9}{'n_tr':>9}{'d_test':>9}{'n_te':>9}  вердикт")
    print("-" * 84)
    for tag, m, dtr, ntr, dte, nte, verdict in rows:
        dtr_s = f"{dtr:+.3f}" if dtr is not None else "—"
        dte_s = f"{dte:+.3f}" if dte is not None else "—"
        print(f"{m:<22}{dtr_s:>9}{int(ntr):>9}{dte_s:>9}{int(nte):>9}  {verdict}")

    n_ok = sum(1 for r in rows if r[0] == "OK")
    n_flip = sum(1 for r in rows if r[0] == "FLIP")
    n_weak = sum(1 for r in rows if r[0] == "WEAK")
    print("\n=== ИТОГ ===")
    print(f"  держатся (можно действовать): {n_ok}")
    print(f"  ФЛИП знака (in-sample переобучение, НЕ трогать): {n_flip}")
    print(f"  нестабильны (роль поплыла): {n_weak}")
    print("\nВ бот несём только вердикты с '✓ держится' И большим n на обоих окнах.")


if __name__ == "__main__":
    main()
