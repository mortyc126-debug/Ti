"""Минимальный grpc-stub — только enum StatusCode, который тянут
invest_api/utils.py и invest_error_decorators.py на уровне модуля.
Реальный grpc здесь не нужен: офлайн-скрипты берут свечи из кэша и к API
не ходят. На боевой машине (где grpc установлен как зависимость
tinkoff-investments) этот stub не активируется — реальный пакет раньше в
sys.path."""
from enum import Enum


class StatusCode(Enum):
    OK = 0
    CANCELLED = 1
    UNKNOWN = 2
    INVALID_ARGUMENT = 3
    DEADLINE_EXCEEDED = 4
    NOT_FOUND = 5
    ALREADY_EXISTS = 6
    PERMISSION_DENIED = 7
    RESOURCE_EXHAUSTED = 8
    FAILED_PRECONDITION = 9
    ABORTED = 10
    OUT_OF_RANGE = 11
    UNIMPLEMENTED = 12
    INTERNAL = 13
    UNAVAILABLE = 14
    DATA_LOSS = 15
    UNAUTHENTICATED = 16


class RpcError(Exception):
    """Заглушка базового gRPC-исключения."""
    pass
