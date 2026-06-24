"""
compare_versions.py — сравнение бэктеста на двух git-коммитах одним прогоном.

Запускать ИЗ ОСНОВНОГО чек-аута invest-bot (там, где обычно запускается
dashboard.py), с активной venv, где установлен tinkoff-investments.

Что делает:
1. Создаёт временный git worktree на коммите OLD_COMMIT рядом (в .worktrees/).
2. Копирует туда settings.ini (с токеном) из текущего чек-аута — в самом
   worktree его обычно нет в .gitignore-чистом виде, но если он закоммичен,
   шаг безопасно перезапишет тем же содержимым.
3. Запускает run_backtest_one(...) из dashboard.py ЭТОГО (HEAD) и ИЗ worktree
   (через subprocess, чтобы не тащить в один процесс два разных дашборда
   с разными версиями oi_composite_strategy.py — конфликт по sys.modules).
4. Печатает обе таблицы рядом для визуального сравнения.

Использование:
    python compare_versions.py SBER,AFLT,GAZP --days 90 --old 24a4022
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

RUNNER = """
import sys, json
sys.path.insert(0, {repo!r})
from dashboard import run_backtest_one

tickers = {tickers!r}
days = {days}
atr_take = {atr_take!r}
atr_stop = {atr_stop!r}

out = {{}}
for t in tickers:
    try:
        out[t] = run_backtest_one(t, days, atr_take, atr_stop)
    except Exception as ex:
        out[t] = [{{"ticker": t, "mode": "ошибка", "error": repr(ex)}}]

print("===JSON_START===")
print(json.dumps(out, default=str))
print("===JSON_END===")
"""


def run_in(repo_dir: str, tickers: list[str], days: int, atr_take: list[float], atr_stop: list[float]) -> dict:
    code = RUNNER.format(repo=repo_dir, tickers=tickers, days=days, atr_take=atr_take, atr_stop=atr_stop)
    proc = subprocess.run([sys.executable, "-c", code], cwd=repo_dir, capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stdout[-3000:], file=sys.stderr)
        print(proc.stderr[-3000:], file=sys.stderr)
        raise RuntimeError(f"подпроцесс в {repo_dir} упал, код {proc.returncode}")
    out = proc.stdout
    start = out.index("===JSON_START===") + len("===JSON_START===")
    end = out.index("===JSON_END===")
    return json.loads(out[start:end].strip())


def fmt_row(r: dict) -> str:
    if "error" in r and r["error"]:
        return f"  {r['mode']:>8}: ошибка — {r['error'][:80]}"
    n = r.get("n_trades", "?")
    wr = r.get("win_rate_pct", r.get("win_rate"))
    exp = r.get("expectancy_pct", r.get("expectancy"))
    return f"  {r.get('mode','?'):>8}: n={n} win%={wr} exp%={exp}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tickers", help="через запятую, напр. SBER,AFLT,GAZP")
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--old", default="24a4022", help="старый коммит для сравнения")
    ap.add_argument("--atr-take", default="2,3,4")
    ap.add_argument("--atr-stop", default="1,1.5,2")
    args = ap.parse_args()

    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    atr_take = [float(x) for x in args.atr_take.split(",")]
    atr_stop = [float(x) for x in args.atr_stop.split(",")]

    repo_root = Path(__file__).resolve().parent
    worktree_dir = repo_root.parent / ".worktrees" / f"old_{args.old}"

    print(f"Готовлю worktree на {args.old} в {worktree_dir} ...")
    worktree_dir.parent.mkdir(parents=True, exist_ok=True)
    if not worktree_dir.exists():
        subprocess.run(["git", "worktree", "add", str(worktree_dir), args.old], cwd=repo_root, check=True)

    # settings.ini обычно не версионируется (там токены) — копируем текущий,
    # чтобы оба прогона дрались с одним и тем же токеном/тикерами.
    cur_settings = repo_root / "settings.ini"
    if cur_settings.exists():
        (worktree_dir / "settings.ini").write_bytes(cur_settings.read_bytes())

    print(f"Прогон на HEAD ({tickers}, {args.days} дн.)...")
    new_out = run_in(str(repo_root), tickers, args.days, atr_take, atr_stop)

    print(f"Прогон на {args.old} ({tickers}, {args.days} дн.)...")
    old_out = run_in(str(worktree_dir), tickers, args.days, atr_take, atr_stop)

    print("\n" + "=" * 70)
    for t in tickers:
        print(f"\n### {t}")
        print(f"-- {args.old} (старый, '{args.old}') --")
        for r in old_out.get(t, []):
            print(fmt_row(r))
        print(f"-- HEAD (текущий) --")
        for r in new_out.get(t, []):
            print(fmt_row(r))

    print("\nГотово. Чтобы убрать worktree: git worktree remove " + str(worktree_dir))


if __name__ == "__main__":
    main()
