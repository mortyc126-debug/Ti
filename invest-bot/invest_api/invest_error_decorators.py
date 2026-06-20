import logging
import time

from grpc import StatusCode
from tinkoff.invest import InvestError, RequestError, AioRequestError

__all__ = ()

logger = logging.getLogger(__name__)


# Method extends logging for Tinkoff api request if it has been failed
def invest_error_logging(func):
    def log_wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except RequestError as ex:
            tracking_id = ex.metadata.tracking_id if ex.metadata else ""
            logger.error("RequestError tracking_id=%s code=%s repr=%s details=%s",
                         tracking_id, str(ex.code), repr(ex), ex.details)
            raise
        except AioRequestError as ex:
            # tracking_id = ex.metadata.tracking_id if ex.metadata else ""
            logger.error("AioRequestError code=%s repr=%s details=%s",
                         str(ex.code), repr(ex), ex.details)
            raise 
        except InvestError as ex:
            logger.error("InvestError repr=%s", repr(ex))
            raise

    return log_wrapper


# Decorator retries api requests for some kind of exceptions
def invest_api_retry(retry_count: int = 5, exceptions: tuple = ( RequestError )):
    def errors_retry(func):

        def errors_wrapper(*args, **kwargs):
            attempts = 0

            while attempts < retry_count - 1:
                attempts += 1

                try:
                    return func(*args, **kwargs)
                except exceptions as ex:
                    logger.error(f"Retry exception attempt: {attempts}")
                    # Без паузы повторный запрос летит в тот же исчерпанный
                    # rate-limit-окно и гарантированно падает ещё раз — особенно
                    # на RESOURCE_EXHAUSTED (ratelimit_reset в metadata говорит,
                    # сколько секунд ждать до сброса окна). Бэкофф: берём
                    # ratelimit_reset, если он есть, иначе экспоненциально
                    # растущую паузу.
                    time.sleep(_retry_delay_seconds(ex, attempts))

            return func(*args, **kwargs)

        return errors_wrapper

    return errors_retry


def _retry_delay_seconds(ex, attempt: int) -> float:
    code = getattr(ex, "code", None)
    metadata = getattr(ex, "metadata", None)
    reset = getattr(metadata, "ratelimit_reset", None) if metadata else None
    if code == StatusCode.RESOURCE_EXHAUSTED and reset:
        try:
            return float(reset) + 0.5
        except (TypeError, ValueError):
            pass
    return min(2.0 ** attempt, 30.0)
