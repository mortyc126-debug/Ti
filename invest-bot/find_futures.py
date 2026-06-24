"""
find_futures.py — показывает все доступные фьючерсы на MOEX,
сгруппированные по базовому активу, с ближайшим контрактом для каждой группы.

Запуск:
    python find_futures.py              # все группы
    python find_futures.py --top 20     # только топ-20 по объёму (если есть)
    python find_futures.py --write Si BR MX  # добавить выбранные в settings.ini

Никаких захардкоженных имён — всё берётся из API Тинькофф.
"""
import argparse
import configparser
import datetime
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from tinkoff.invest import Client, InstrumentStatus
from invest_api.invest_target import INVEST_TARGET
from invest_api.utils import moneyvalue_to_decimal

TOKEN_FILE = "settings.ini"


def _token() -> str:
    cfg = configparser.ConfigParser()
    cfg.read(TOKEN_FILE, encoding="utf-8")
    return cfg["INVEST_API"]["TOKEN"]


def _app_name() -> str:
    cfg = configparser.ConfigParser()
    cfg.read(TOKEN_FILE, encoding="utf-8")
    return cfg["INVEST_API"].get("APP_NAME", "invest-bot")


def find_all_nearest(token: str, app_name: str) -> list[dict]:
    """
    Запрашивает все фьючерсы из API, группирует по basic_asset,
    для каждой группы выбирает ближайший по экспирации непросроченный контракт.
    Возвращает список словарей, отсортированных по basic_asset.
    """
    now = datetime.datetime.now(datetime.timezone.utc)

    # basic_asset -> список контрактов
    groups: dict[str, list] = {}

    with Client(token, app_name=app_name, target=INVEST_TARGET) as client:
        all_futures = client.instruments.futures(
            instrument_status=InstrumentStatus.INSTRUMENT_STATUS_BASE
        ).instruments

        for f in all_futures:
            if not f.api_trade_available_flag:
                continue
            if f.expiration_date <= now:
                continue
            asset = f.basic_asset or "—"
            groups.setdefault(asset, []).append(f)

        results = []
        for asset, contracts in sorted(groups.items()):
            # ближайший по экспирации
            nearest = min(contracts, key=lambda x: x.expiration_date)

            # ГО через отдельный вызов
            try:
                margin = client.instruments.get_futures_margin(figi=nearest.figi)
                go = max(
                    float(moneyvalue_to_decimal(margin.initial_margin_on_buy)),
                    float(moneyvalue_to_decimal(margin.initial_margin_on_sell)),
                )
                min_step = moneyvalue_to_decimal(margin.min_price_increment)
                min_step_amount = moneyvalue_to_decimal(margin.min_price_increment_amount)
                point_value = float(min_step_amount / min_step) if min_step else 1.0
            except Exception:
                go = 0.0
                point_value = 1.0

            results.append({
                "basic_asset": asset,
                "ticker": nearest.ticker,
                "figi": nearest.figi,
                "name": nearest.name,
                "expiration": nearest.expiration_date.strftime("%Y-%m-%d"),
                "lot": nearest.lot,
                "short": nearest.short_enabled_flag,
                "go_rub": go,
                "point_value": point_value,
                "n_contracts": len(contracts),
            })

    return results


def write_to_settings(basic_assets: list[str], results: list[dict]) -> None:
    """Добавляет найденные фьючерсы в settings.ini как новые STRATEGY_* секции."""
    cfg = configparser.ConfigParser()
    cfg.read(TOKEN_FILE)

    lookup = {r["basic_asset"]: r for r in results}
    added = []

    for asset in basic_assets:
        r = lookup.get(asset)
        if r is None:
            print(f"  ! basic_asset '{asset}' не найден в результатах")
            continue

        key = r["ticker"].upper()
        # убираем цифры суффикса: SiZ5 -> Si, BRQ5 -> BR, MXU5 -> MX
        prefix = "".join(c for c in key if c.isalpha())
        section = f"STRATEGY_{prefix}"
        section_s = f"STRATEGY_{prefix}_SETTINGS"

        if cfg.has_section(section):
            print(f"  ~ {section} уже есть в settings.ini, пропускаю")
            continue

        cfg.add_section(section)
        cfg.set(section, "STRATEGY_NAME", "OICompositeStrategy")
        cfg.set(section, "TICKER", r["ticker"])
        cfg.set(section, "FIGI", r["figi"])
        cfg.set(section, "MAX_LOTS_PER_ORDER", "1")
        cfg.set(section, "IS_FUTURE", "1")

        cfg.add_section(section_s)
        cfg.set(section_s, "SIGNAL_THRESHOLD", "0.25")
        cfg.set(section_s, "LONG_TAKE", "1.003")
        cfg.set(section_s, "LONG_STOP", "0.998")
        cfg.set(section_s, "SHORT_TAKE", "0.997")
        cfg.set(section_s, "SHORT_STOP", "1.002")
        cfg.set(section_s, "SIGNAL_ONLY", "1")
        cfg.set(section_s, "ATR_TAKE_K", "3")
        cfg.set(section_s, "ATR_STOP_K", "1.5")

        added.append(r["ticker"])

    if added:
        with open(TOKEN_FILE, "w", encoding="utf-8", newline="\n") as f:
            cfg.write(f)
        print(f"\n  ✓ Добавлено в settings.ini: {', '.join(added)}")
        print("  Контракты устаревают при экспирации — перезапускай find_futures.py раз в квартал")
    else:
        print("  Ничего не добавлено")


def main() -> None:
    parser = argparse.ArgumentParser(description="Поиск ближайших фьючерсных контрактов через API Тинькофф")
    parser.add_argument("--write", nargs="+", metavar="BASIC_ASSET",
                        help="Записать указанные basic_asset в settings.ini (напр. --write USD000UTSTOM BR)")
    parser.add_argument("--filter", nargs="+", metavar="SUBSTR",
                        help="Показать только группы где basic_asset содержит подстроку (напр. --filter USD BR MX)")
    args = parser.parse_args()

    token = _token()
    app = _app_name()

    print("Запрашиваю список фьючерсов из API...", flush=True)
    results = find_all_nearest(token, app)

    if args.filter:
        filters = [f.upper() for f in args.filter]
        results = [r for r in results if any(f in r["basic_asset"].upper() or f in r["ticker"].upper() for f in filters)]

    print(f"\n{'BASIC_ASSET':<22} {'БЛИЖАЙШИЙ':<12} {'ЭКСПИРАЦИЯ':<12} {'ГО, ₽':>10} {'ПУНКТ, ₽':>10} {'ШОРТ':<6} {'КОНТРАКТОВ'}")
    print("-" * 90)
    for r in results:
        go_str = f"{r['go_rub']:,.0f}" if r["go_rub"] else "—"
        pv_str = f"{r['point_value']:.4f}"
        short_str = "да" if r["short"] else "нет"
        print(f"{r['basic_asset']:<22} {r['ticker']:<12} {r['expiration']:<12} {go_str:>10} {pv_str:>10} {short_str:<6} {r['n_contracts']}")

    print(f"\nВсего групп: {len(results)}")
    print("\nЧтобы добавить в settings.ini, запусти:")
    print("  python find_futures.py --write <BASIC_ASSET> [<BASIC_ASSET> ...]")
    print("  (используй значения из колонки BASIC_ASSET выше)")

    if args.write:
        print(f"\nЗаписываю: {args.write}")
        write_to_settings(args.write, results)


if __name__ == "__main__":
    main()
