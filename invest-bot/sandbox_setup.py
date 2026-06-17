"""
sandbox_setup.py — разовый скрипт: открыть sandbox-счёт и положить виртуальные
деньги. Запускать вручную один раз (или когда нужен новый виртуальный счёт),
не часть торгового цикла.

Использование:
    TINKOFF_SANDBOX=1 python sandbox_setup.py [сумма_в_рублях]

Токен берётся из settings.ini [INVEST_API] TOKEN — туда нужно вписать токен,
выпущенный в режиме sandbox (обычный боевой токен в песочнице не работает).
"""
import sys

from tinkoff.invest import Client, MoneyValue
from tinkoff.invest.constants import INVEST_GRPC_API_SANDBOX

from configuration.configuration import ProgramConfiguration

CONFIG_FILE = "settings.ini"
DEFAULT_AMOUNT_RUB = 100_000


def main() -> None:
    amount = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_AMOUNT_RUB

    config = ProgramConfiguration(CONFIG_FILE)

    with Client(config.tinkoff_token, app_name=config.tinkoff_app_name, target=INVEST_GRPC_API_SANDBOX) as client:
        existing = client.sandbox.get_sandbox_accounts().accounts
        if existing:
            account_id = existing[0].id
            print(f"Уже есть sandbox-счёт: {account_id}")
        else:
            account_id = client.sandbox.open_sandbox_account().account_id
            print(f"Создан sandbox-счёт: {account_id}")

        client.sandbox.sandbox_pay_in(
            account_id=account_id,
            amount=MoneyValue(currency="rub", units=amount, nano=0),
        )
        print(f"Зачислено {amount} RUB на счёт {account_id}")

        portfolio = client.sandbox.get_sandbox_portfolio(account_id=account_id)
        print(f"Текущий портфель: {portfolio}")


if __name__ == "__main__":
    main()
