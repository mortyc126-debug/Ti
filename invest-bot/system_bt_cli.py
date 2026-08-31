"""system_bt_cli.py — CLI-обёртка над dashboard.run_system_backtest.

Системный OOS-прогон ЖИВЫХ стратегий бота (composite/accel/NW/level/...) на
кэше свечей, без веб-дашборда. Каждый тикер — через ту стратегию, которой он
торгует вживую; метрика exp_atr/win/N на held-out окне (прогрев=train,
сигналы=OOS) — тот же честный split, что и в channels_lab_validate.py.

Зачем: сравнить реальную начинку бота с находкой сессии channel_level_fut
(channels_lab: на 22 фьючерсах 1ч test +0.518 ATR/сделку). Обе метрики —
экспектанси сделки в ATR на held-out окне, шкала сопоставима (симулятор
system_backtest.simulate_analyze_strategy — тот же, что портирован в btStats).

Прогон читает кэш и настройки бота (settings.ini / oi_tickers.json); сети не
трогает (cache-miss по тикеру → пропуск, не ошибка). Тикеры должны быть в
настройках бота (для фьючерсов — заполни find_futures.py).

Пример:
  python system_bt_cli.py --days 365 --split-frac 0.6 --cost 0.12 \
      --tickers SiU6,EuM6,MXU6,BTM6,BTN6,NAU6,GLU6,MMU6,CEU6,RNU6
"""
import argparse
import sys


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--split-frac", type=float, default=0.6)
    ap.add_argument("--cost", type=float, default=0.12,
                    help="комиссия в ATR (как в channels_lab: 0.12 для 1ч)")
    ap.add_argument("--tickers", default=None,
                    help="через запятую; пусто = все тикеры из settings бота")
    ap.add_argument("--preset", default=None,
                    help="опц. пресет методов для composite-референса")
    a = ap.parse_args()

    # dashboard.py читает settings.ini относительно CWD (CONFIG_FILE=
    # "settings.ini") ещё на импорте. Чтобы скрипт работал из любой папки —
    # переходим в директорию самого скрипта (там лежит settings.ini бота).
    import os
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    # Импорт тяжёлый (тянет конфиг бота) — держим внутри main, чтобы --help был
    # мгновенным и без побочных эффектов.
    try:
        import dashboard
    except KeyError as e:
        sys.exit(f"[конфиг] в settings.ini нет секции/ключа {e}. Нужен рабочий "
                 f"settings.ini бота (с [INVEST_API]) в папке invest-bot.")
    except Exception as e:
        sys.exit(f"[import dashboard] {type(e).__name__}: {e}")

    tickers = None
    if a.tickers:
        tickers = [t.strip().upper() for t in a.tickers.split(",") if t.strip()]

    res = dashboard.run_system_backtest(days=a.days, split_frac=a.split_frac,
                                        cost_atr=a.cost, tickers=tickers,
                                        preset=a.preset)

    print(f"\nСИСТЕМНЫЙ OOS-ПРОГОН  days={res['days']}  split={res['split_frac']}  "
          f"cost={res['cost_atr']}  (оценено {res['evaluated']}, "
          f"пропущено {res['skipped']}, ошибок {res['errored']})")

    bys = res.get("by_strategy", {})
    if bys:
        print(f"\n═══ СВОД ПО СТРАТЕГИЯМ (взвеш. по N) ═══")
        print(f"  {'стратегия':<30} {'тикеров':>7} {'N':>6} {'win%':>6} {'exp_atr':>9}")
        for name, v in sorted(bys.items(), key=lambda kv: kv[1].get("exp_atr", 0), reverse=True):
            print(f"  {name:<30} {v.get('tickers', 0):>7} {v.get('n', 0):>6} "
                  f"{v.get('win', 0) * 100:>5.1f}% {v.get('exp_atr', 0):>+9.3f}")
        print(f"\n  Для сравнения: channel_level_fut (channels_lab, 22 фьюча 1ч) "
              f"— test exp +0.518 ATR/сделку.")

    # Per-ticker детализация — увидеть, где живая стратегия плюс/минус.
    rows = [r for r in res.get("rows", []) if r.get("n")]
    if rows:
        print(f"\n═══ ПО ТИКЕРАМ ═══")
        print(f"  {'тикер':<8} {'стратегия':<26} {'N':>5} {'win%':>6} {'exp_atr':>9}")
        for r in sorted(rows, key=lambda x: x.get("exp_atr", 0), reverse=True):
            print(f"  {r.get('ticker', ''):<8} {r.get('strategy', ''):<26} "
                  f"{r['n']:>5} {r.get('win', 0) * 100:>5.1f}% {r.get('exp_atr', 0):>+9.3f}")

    # Пропущенные — чтобы было видно, кого не посчитали и почему.
    sk = [r for r in res.get("rows", []) if r.get("skipped")]
    if sk:
        print(f"\n  пропущены: " + ", ".join(f"{r.get('ticker','?')}({r['skipped']})" for r in sk[:20]))


if __name__ == "__main__":
    main()
