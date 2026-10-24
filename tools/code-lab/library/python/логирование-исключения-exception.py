import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

try:
    int("не число")
except ValueError:
    logger.exception("Не удалось разобрать входное значение")
