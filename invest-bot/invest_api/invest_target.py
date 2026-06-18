"""
invest_target.py — переключатель боевого/sandbox эндпоинта Tinkoff Invest API.

TINKOFF_SANDBOX=1 (env) -> все Client/AsyncClient в invest_api/services идут
в песочницу (sandbox-invest-public-api), а не на реальный счёт. Нужен токен,
выпущенный в режиме sandbox (обычный боевой токен в песочнице не работает).
"""
import os

from tinkoff.invest.constants import INVEST_GRPC_API, INVEST_GRPC_API_SANDBOX

__all__ = ("INVEST_TARGET",)

INVEST_TARGET = INVEST_GRPC_API_SANDBOX if os.getenv("TINKOFF_SANDBOX") == "1" else INVEST_GRPC_API
