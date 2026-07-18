r"""
nw_bank_refresh.py — ночное авто-обновление банка NW-памяти для live-бота.

Делает два шага одной командой:
  1. prefetch_candles — инкрементально докачивает свежие свечи в candle_cache
     (только то, чего не хватает; тёплый кэш = минуты);
  2. nw_bank_build --liquid-only — пересобирает data/nw_bank.npz (атомарно:
     tmp + os.replace, чтобы бот не прочитал недописанный файл).

Бот с горячей перезагрузкой (NWGlobalStrategy → NWMemoryGlobal.maybe_reload)
подхватит новый банк на смене торгового дня БЕЗ перезапуска.

Развязано с торговым циклом намеренно: сетевой prefetch не лезет в живой
трейд, крутится ночью планировщиком ОС. Любой шаг падает → лог + ненулевой
код возврата, старый банк остаётся рабочим (не перетираем при ошибке build).

Планировщик (Windows, раз в сутки в 04:00, разово настроить):
    schtasks /create /tn "NWBankRefresh" /tr ^
      "py -3.11 C:\Users\mortn\ti\invest-bot\nw_bank_refresh.py" ^
      /sc daily /st 04:00

Linux/cron:
    0 4 * * *  cd /path/invest-bot && python3 nw_bank_refresh.py

Запуск вручную:
    py -3.11 nw_bank_refresh.py
    py -3.11 nw_bank_refresh.py --days 400 --skip-prefetch   (только пересборка)
"""
import os
import sys
import subprocess
import argparse
from datetime import datetime

_HERE = os.path.dirname(os.path.abspath(__file__))


def _run(cmd):
    print(f"[{datetime.now():%H:%M:%S}] $ {' '.join(cmd)}", flush=True)
    r = subprocess.run(cmd, cwd=_HERE)
    return r.returncode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=400, help="глубина свечей для prefetch")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--skip-prefetch", action="store_true",
                    help="не качать свечи, только пересобрать банк из текущего candle_cache")
    ap.add_argument("--out", default=None, help="куда писать банк (по умолчанию data/nw_bank.npz)")
    args = ap.parse_args()
    py = sys.executable  # тот же интерпретатор, что запустил скрипт

    if not args.skip_prefetch:
        rc = _run([py, "prefetch_candles.py", "--days", str(args.days), "--workers", str(args.workers)])
        if rc != 0:
            # prefetch мог частично упасть (лимиты Tinkoff) — не критично, банк
            # соберём из того, что есть. Предупреждаем, но продолжаем.
            print(f"ВНИМАНИЕ: prefetch вернул код {rc} — собираю банк из наличного кэша", flush=True)

    build = [py, "nw_bank_build.py", "--liquid-only"]
    if args.out:
        build += ["--out", args.out]
    rc = _run(build)
    if rc != 0:
        print("ОШИБКА: сборка банка не удалась — старый банк остаётся рабочим", flush=True)
        return rc
    print(f"[{datetime.now():%H:%M:%S}] банк обновлён", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
