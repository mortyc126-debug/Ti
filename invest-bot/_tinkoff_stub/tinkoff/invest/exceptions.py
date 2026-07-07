"""tinkoff.invest.exceptions stub — только для except RequestError в
офлайн-скриптах (redundancy_analysis, lag_analysis). Реальный API не
дёргается, если свечи есть в локальном кэше."""


class RequestError(Exception):
    """Заглушка. Реальный SDK кидает её на ошибках gRPC — офлайн-скрипты
    туда не ходят, но ловят в except, поэтому класс должен существовать."""
    def __init__(self, code=None, details=None, metadata=None):
        self.code = code
        self.details = details
        self.metadata = metadata
        super().__init__(details or "RequestError (stub)")
