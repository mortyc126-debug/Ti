import logging
from dataclasses import dataclass, field

from tinkoff.invest import Client, AccessLevel, AccountType, AccountStatus
from invest_api.invest_target import INVEST_TARGET

from configuration.settings import AccountSettings
from invest_api.invest_error_decorators import invest_error_logging, invest_api_retry

__all__ = ("AccountService", "AccountInfo")


_ACCOUNT_TYPE_NAMES = {
    AccountType.ACCOUNT_TYPE_TINKOFF:     "Брокерский",
    AccountType.ACCOUNT_TYPE_TINKOFF_IIS: "ИИС",
    AccountType.ACCOUNT_TYPE_INVEST_BOX:  "Копилка",
}


@dataclass
class AccountInfo:
    id: str
    name: str
    account_type: str        # «Брокерский» / «ИИС» / …
    liquid_portfolio: int    # ликвидный портфель в единицах (₽)
    margin_ok: bool          # liquid > starting_margin

logger = logging.getLogger(__name__)


class AccountService:
    """
    The class encapsulate tinkoff account api
    """
    def __init__(self, token: str, app_name: str) -> None:
        self.__token = token
        self.__app_name = app_name

    @invest_api_retry()
    @invest_error_logging
    def list_all_accounts(self) -> list[AccountInfo]:
        """Возвращает все открытые счёта с полным доступом (брокерские + ИИС)."""
        result = []
        _tradeable = {AccountType.ACCOUNT_TYPE_TINKOFF, AccountType.ACCOUNT_TYPE_TINKOFF_IIS}
        with Client(self.__token, app_name=self.__app_name, target=INVEST_TARGET) as client:
            for account in client.users.get_accounts().accounts:
                if account.access_level != AccessLevel.ACCOUNT_ACCESS_LEVEL_FULL_ACCESS:
                    continue
                if account.status != AccountStatus.ACCOUNT_STATUS_OPEN:
                    continue
                if account.type not in _tradeable:
                    continue
                try:
                    margin = client.users.get_margin_attributes(account_id=account.id)
                    liquid = margin.liquid_portfolio.units
                    margin_ok = liquid > margin.starting_margin.units
                except Exception:
                    liquid = 0
                    margin_ok = False
                result.append(AccountInfo(
                    id=account.id,
                    name=account.name or account.id,
                    account_type=_ACCOUNT_TYPE_NAMES.get(account.type, "Другой"),
                    liquid_portfolio=liquid,
                    margin_ok=margin_ok,
                ))
        return result

    @invest_api_retry()
    @invest_error_logging
    def trading_account_id(self, account_settings: AccountSettings) -> str:
        """Обратная совместимость: возвращает один счёт с максимальным балансом."""
        accounts = self.trading_account_ids(account_settings)
        return accounts[0] if accounts else None

    def trading_account_ids(
        self,
        account_settings: AccountSettings,
        enabled_ids: list[str] | None = None,
    ) -> list["AccountInfo"]:
        """
        Возвращает список AccountInfo для торговли.
        enabled_ids=None → все подходящие счета.
        enabled_ids=[...] → только те, что в списке и прошли фильтр.
        """
        all_accounts = self.list_all_accounts()
        result = []
        for acc in all_accounts:
            if acc.liquid_portfolio < account_settings.min_liquid_portfolio:
                logger.info(f"Счёт {acc.id} ({acc.name}): мало средств ({acc.liquid_portfolio} ₽), пропуск")
                continue
            if not acc.margin_ok:
                logger.info(f"Счёт {acc.id} ({acc.name}): маржа не ОК, пропуск")
                continue
            if enabled_ids is not None and acc.id not in enabled_ids:
                logger.info(f"Счёт {acc.id} ({acc.name}): не в списке включённых, пропуск")
                continue
            result.append(acc)
        # сортируем по убыванию баланса — для детерминированного порядка в логах
        result.sort(key=lambda a: a.liquid_portfolio, reverse=True)
        return result

    @invest_api_retry()
    @invest_error_logging
    def __verify(self) -> bool:
        """
        Verification method. Just connect and read some settings.
        """
        logger.info(f"Start client verification. App name: {self.__app_name}")

        with Client(self.__token, app_name=self.__app_name, target=INVEST_TARGET) as client:
            accounts = client.users.get_accounts()

            logger.info("List of client accounts:")
            for account in accounts.accounts:
                logger.info(account)

            tariff = client.users.get_user_tariff()

            logger.info("Current unary limits:")
            for unary_limit in tariff.unary_limits:
                logger.info(f"Request per minutes: {unary_limit.limit_per_minute}")
                logger.info("\t" + "\n\t".join(unary_limit.methods))

            logger.info("Current stream limits:")
            for stream_limit in tariff.stream_limits:
                logger.info(f"Connections {stream_limit.limit}:")
                logger.info("\t" + "\n\t".join(stream_limit.streams))

            logger.info("Client information:")
            logger.info(client.users.get_info())

        logger.info("Verification has been passed successfully.")

        return True

    def verify_token(self) -> bool:
        """
        Tinkoff API token verification
        :return: True - token is good, False - Try another one.
        """
        try:
            return self.__verify()
        except Exception as ex:
            logger.error(f"Verify error - {repr(ex)}")
            return False
