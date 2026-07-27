"""
prefetch_top_liq.py — быстрая докачка глубокой истории только для топ-N
самых ликвидных тикеров из уже собранного кэша. Обёртка поверх
prefetch_candles.py.

Проблема: скачать 400+ дней истории для всех 700 тикеров при лимите
Tinkoff 600 req/60s = 10 rps физически занимает часы (400 запросов на
тикер, 400×700=280k запросов ≈ 8 часов). А для валидации методов (oos_diff,
walk_forward) нужны только те тикеры, что реально в топ-50 по обороту —
за 5-10 минут докачиваются.

Отбор — тот же, что в score_methods.py:_list_tickers (медианный дневной
close×volume по последним --liq-days дням из уже накопленного кэша). То
есть если у тебя в кэше уже есть 60 дней истории — можно один раз отобрать
топ, и потом только их углублять на N лет.

Использование:
  # 720 дней истории для топ-50 ликвидных, 6 воркеров, delay 0.4s
  python prefetch_top_liq.py --days 720 --top-liq 50 --workers 6 --delay 0.4

  # предпросмотр отбора — не качает, только печатает выбранных
  python prefetch_top_liq.py --dry-run

Тайминги (грубо, если весь кэш холодный):
  --top-liq  50 --days 400 → ~15 мин при 10 rps
  --top-liq  50 --days 720 → ~30 мин
  --top-liq 100 --days 720 → ~60 мин
  --top-liq 200 --days 720 → ~2 часа

Если кэш уже частично прогрет — качается ТОЛЬКО дельта (что старше
имеющегося). Повторный запуск с большими --days бесплатно прогревает
только новые дни, старые пропускает.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Переиспользуем отбор из score_methods — там уже готовая функция.
from score_methods import _list_tickers  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="Докачать глубокую историю только для топ-ликвидных тикеров")
    ap.add_argument("--days", type=int, default=720, help="Сколько дней истории тянуть (default 720 ≈ 2 года)")
    ap.add_argument("--top-liq", type=int, default=50, help="Топ-N по обороту (default 50)")
    ap.add_argument("--liq-days", type=int, default=60, help="Окно для расчёта ликвид/вол при отборе (default 60)")
    ap.add_argument("--min-vol-pctl", type=float, default=10.0)
    ap.add_argument("--max-vol-pctl", type=float, default=95.0)
    ap.add_argument("--workers", type=int, default=5, help="Параллельных потоков (default 5). Не более 7 — иначе rate-limit.")
    ap.add_argument("--delay", type=float, default=None,
                     help="Задержка между запросами внутри одного потока в секундах "
                          "(default: автоматически по формуле workers*0.1). Меньшее ускоряет, "
                          "но при workers*rate > 10rps ловишь RESOURCE_EXHAUSTED.")
    ap.add_argument("--cache", default=os.path.join(HERE, "data", "candle_cache"))
    ap.add_argument("--interval", type=int, default=5)
    ap.add_argument("--dry-run", action="store_true", help="Только показать какие тикеры отобраны, не качать")
    args = ap.parse_args()

    print(f"[prefetch_top_liq] отбор из кэша {args.cache} (окно {args.liq_days} дн)...", file=sys.stderr)
    tickers = _list_tickers(
        args.cache, args.interval,
        top_liq=args.top_liq,
        liq_days=args.liq_days,
        min_vol_pctl=args.min_vol_pctl,
        max_vol_pctl=args.max_vol_pctl,
        workers=args.workers,
    )
    if not tickers:
        sys.exit("[prefetch_top_liq] ничего не отобрано — кэш пуст или все фильтры отсекли всё")

    print(f"[prefetch_top_liq] отобрано {len(tickers)} тикеров:", file=sys.stderr)
    print(", ".join(tickers), file=sys.stderr)

    if args.dry_run:
        print(f"[prefetch_top_liq] --dry-run: докачка не запущена", file=sys.stderr)
        return

    # Формула: delay ≥ workers × 0.1 держит суммарный rate ≤ 10 rps (лимит Tinkoff).
    delay = args.delay if args.delay is not None else max(0.2, args.workers * 0.1)
    env = os.environ.copy()
    env["CANDLE_REQUEST_DELAY"] = str(delay)

    cmd = [
        sys.executable, os.path.join(HERE, "prefetch_candles.py"),
        "--days", str(args.days),
        "--workers", str(args.workers),
        "--tickers", ",".join(tickers),
    ]
    est_rps = args.workers / delay
    est_min = int(args.days * len(tickers) / est_rps / 60)
    print(f"[prefetch_top_liq] запуск: {len(tickers)} тикеров × {args.days} дн, "
          f"{args.workers} воркеров, delay {delay}s → ~{est_rps:.1f} rps → "
          f"грубая оценка {est_min} мин (по холодному кэшу; если есть уже — меньше)",
          file=sys.stderr)
    print(f"[prefetch_top_liq] CANDLE_REQUEST_DELAY={delay} " + " ".join(cmd[len(cmd)-6:]),
          file=sys.stderr)
    subprocess.check_call(cmd, cwd=HERE, env=env)


if __name__ == "__main__":
    main()
