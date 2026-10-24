import logging
import tempfile
from logging.handlers import RotatingFileHandler
from pathlib import Path

with tempfile.TemporaryDirectory() as folder:
    path = Path(folder) / "app.log"
    logger = logging.getLogger("rotation_demo")
    logger.setLevel(logging.INFO)
    handler = RotatingFileHandler(path, maxBytes=80, backupCount=2, encoding="utf-8")
    logger.addHandler(handler)
    try:
        for i in range(10):
            logger.info("event number %s with some details", i)
    finally:
        handler.close()
        logger.removeHandler(handler)
    assert path.exists()
    print("log exists:", path.exists())
