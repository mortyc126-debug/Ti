import logging

def setup_logger(name="my_app", level=logging.DEBUG):
    logger = logging.getLogger(name)
    logger.setLevel(level)
    logger.propagate = False

    if not logger.handlers:   # защита от дублирования при повторном вызове
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter(
            "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
        ))
        logger.addHandler(handler)
    return logger

logger = setup_logger()

logger.debug("Отладочное сообщение (видно, пока уровень DEBUG)")
logger.info("Приложение запущено")
logger.warning("Уровень ресурсов низкий")

try:
    open("missing.txt")
except FileNotFoundError:
    logger.exception("Ошибка при чтении файла")   # с трассировкой