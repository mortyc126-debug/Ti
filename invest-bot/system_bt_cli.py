"""system_bt_cli.py — системный OOS-прогон стратегий бота, ИНКРЕМЕНТАЛЬНО.

Гоняет живые стратегии бота (composite/accel/NW/level/...) на кэше свечей
через system_backtest.simulate_analyze_strategy с train/test split. В отличие
от dashboard.run_system_backtest (возвращает всё одним куском в конце — при
зависании на тяжёлом тикере теряется весь прогон), здесь КАЖДЫЙ ТИКЕР
печатается сразу (flush) и дописывается в CSV. Завис на одном — предыдущие
сохранены.

Метрика exp_atr/win/N на held-out окне (прогрев=train, сигналы=OOS) — та же
шкала, что в channels_lab_validate.py. Для сравнения: channel_level_fut на
22 фьючах 1ч — test exp +0.518 ATR/сделку.

Читает кэш и settings.ini бота; сети не трогает (cache-miss → пропуск).
Тикеры должны быть в настройках бота (фьючерсы — заполни find_futures.py).

Пример:
  python invest-bot\\system_bt_cli.py --days 365 --split-frac 0.6 --cost 0.12 \\
      --force-strategy NWMemoryStrategy --tickers SiU6,EuM6,MXU6,GLU6,MMU6
"""
import argparse
import csv
import os
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
    ap.add_argument("--force-strategy", default=None,
                    help="прогнать ВСЕ тикеры через эту стратегию, минуя живой "
                         "маппинг (OICompositeStrategy/HierarchicalStrategy/"
                         "LevelReactionStrategy/AccelFadeStrategy/NWMemoryStrategy/"
                         "NWGlobalStrategy).")
    ap.add_argument("--out", default=None,
                    help="CSV для инкрементальной записи (default: "
                         "data/system_bt_<strategy>.csv)")
    ap.add_argument("--fresh", action="store_true",
                    help="начать заново (перезаписать CSV). По умолчанию — "
                         "докачка: уже посчитанные тикеры из CSV пропускаются.")
    a = ap.parse_args()

    # dashboard.py читает settings.ini относительно CWD ещё на импорте — переходим
    # в папку скрипта (там settings.ini бота), чтобы работать из любой директории.
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    try:
        import dashboard as D
        import system_backtest as sysbt
        import dataclasses
    except KeyError as e:
        sys.exit(f"[конфиг] в settings.ini нет секции/ключа {e}. Нужен рабочий "
                 f"settings.ini бота (с [INVEST_API]) в папке invest-bot.")
    except Exception as e:
        sys.exit(f"[import] {type(e).__name__}: {e}")

    if a.force_strategy:
        try:
            D._config.trading_settings.strategy_override = a.force_strategy
            D._config.futures_trading_settings.strategy_map = {}
        except Exception as e:
            sys.exit(f"[force] не смог выставить override: {e}")
        print(f"[force] все тикеры → {a.force_strategy}", file=sys.stderr, flush=True)

    by_ticker = D._all_settings_by_ticker()
    strat_map = D._config.futures_trading_settings.strategy_map
    override = D._config.trading_settings.strategy_override
    names = ([t.strip().upper() for t in a.tickers.split(",") if t.strip()]
             if a.tickers else list(by_ticker.keys()))

    out_path = a.out or os.path.join("data",
                f"system_bt_{a.force_strategy or 'live'}.csv")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    # Докачка: читаем уже посчитанные тикеры из CSV, пропускаем их. Прошлые
    # строки подхватываем в rows, чтобы свод учёл и их. --fresh = начать заново.
    done = set()
    rows = []
    resume = os.path.exists(out_path) and not a.fresh
    if resume:
        try:
            with open(out_path, newline="", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    done.add(row["ticker"])
                    if row.get("n") and int(float(row["n"])):
                        rows.append({"strategy": row["strategy"], "n": int(float(row["n"])),
                                     "win": float(row["win"]), "exp_atr": float(row["exp_atr"])})
        except Exception:
            done = set(); rows = []; resume = False
    fout = open(out_path, "a" if resume else "w", newline="", encoding="utf-8")
    wr = csv.writer(fout)
    if not resume:
        wr.writerow(["ticker", "strategy", "n", "win", "exp_atr"]); fout.flush()

    print(f"\nСИСТЕМНЫЙ OOS  days={a.days} split={a.split_frac} cost={a.cost}  "
          f"→ пишу в {out_path}" + (f"  (докачка: {len(done)} готово)" if done else ""))
    print(f"  {'тикер':<8} {'стратегия':<24} {'N':>6} {'win%':>6} {'exp_atr':>9}",
          flush=True)

    for tk in names:
        if tk in done:
            continue  # уже посчитан в прошлом запуске (докачка)
        settings = by_ticker.get(tk)
        if settings is None:
            print(f"  {tk:<8} {'—':<24} {'нет в settings':>24}", flush=True)
            continue
        base = getattr(D, "_futures_base_by_ticker", {}).get(tk, tk)
        live = sysbt.live_strategy_name(tk, base, strat_map, override,
                                        default=settings.name)
        try:
            candles = D._system_candles(tk, settings, a.days)
        except Exception:
            print(f"  {tk:<8} {live:<24} {'нет свечей':>24}", flush=True)
            continue
        if not candles or len(candles) < 200:
            print(f"  {tk:<8} {live:<24} {'мало свечей':>24}", flush=True)
            continue
        split_idx = int(len(candles) * a.split_frac)
        # Прогресс ДО расчёта — видно, какой тикер считается прямо сейчас
        # (медленные стратегии типа LevelReaction идут часами на тикер).
        print(f"  … считаю {tk} ({len(candles)} свечей, тест с {split_idx})…",
              file=sys.stderr, flush=True)
        try:
            st = dataclasses.replace(D._backtest_strategy_settings(settings), name=live)
            strat = D.StrategyFactory.new_factory(live, st)
            if strat is None:
                print(f"  {tk:<8} {live:<24} {'стратегия не создана':>24}", flush=True)
                continue
            try:
                D._wire_backtest_providers(strat, settings.ticker, a.days)
            except Exception:
                pass  # провайдеры (OI и т.п.) не критичны для price-стратегий
            res = sysbt.simulate_analyze_strategy(strat, candles, split_idx, cost_atr=a.cost)
        except Exception as e:
            print(f"  {tk:<8} {live:<24} ошибка: {type(e).__name__}: {e}", flush=True)
            continue
        n = res.get("n", 0); win = res.get("win", 0.0); exp = res.get("exp_atr", 0.0)
        print(f"  {tk:<8} {live:<24} {n:>6} {win * 100:>5.1f}% {exp:>+9.3f}", flush=True)
        wr.writerow([tk, live, n, round(win, 4), round(exp, 4)]); fout.flush()
        if n:
            rows.append({"strategy": live, "n": n, "win": win, "exp_atr": exp})

    fout.close()

    # Свод по стратегиям (взвеш. по N).
    by_strategy = {}
    for r in rows:
        agg = by_strategy.setdefault(r["strategy"], {"n": 0, "wsum": 0.0, "winsum": 0.0, "t": 0})
        agg["n"] += r["n"]; agg["wsum"] += r["exp_atr"] * r["n"]
        agg["winsum"] += r["win"] * r["n"]; agg["t"] += 1
    print(f"\n═══ СВОД ПО СТРАТЕГИЯМ (взвеш. по N) ═══")
    print(f"  {'стратегия':<26} {'тикеров':>7} {'N':>6} {'win%':>6} {'exp_atr':>9}")
    for name, agg in sorted(by_strategy.items(),
                            key=lambda kv: kv[1]["wsum"] / (kv[1]["n"] or 1), reverse=True):
        n = agg["n"] or 1
        print(f"  {name:<26} {agg['t']:>7} {agg['n']:>6} "
              f"{agg['winsum'] / n * 100:>5.1f}% {agg['wsum'] / n:>+9.3f}")
    print(f"\n  Сравнение: channel_level_fut (channels_lab, 22 фьюча 1ч) "
          f"— test exp +0.518 ATR/сделку.")


if __name__ == "__main__":
    main()
