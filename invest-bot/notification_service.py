"""
notification_service.py — единый слой уведомлений бота.

Шлёт события (ошибки, инфо, управление) в два места одновременно:
  1. Telegram — через Blogger (asyncio.Queue → BlogWorker)
  2. data/bot_events.json — файл, который дашборд читает через /api/bot_events

Файл хранит последние BOT_EVENTS_MAX записей (LIFO). Дашборд опрашивает
его раз в 3 сек и показывает в панели «Лог бота».
"""
import json
import logging
import os
import traceback
from datetime import datetime, timezone

__all__ = ("NotificationService",)

logger = logging.getLogger(__name__)

BOT_EVENTS_FILE = "data/bot_events.json"
BOT_EVENTS_MAX = 200


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def _append_event(level: str, text: str) -> None:
    """Добавляет запись в bot_events.json; не бросает исключений — только логирует."""
    try:
        os.makedirs("data", exist_ok=True)
        try:
            with open(BOT_EVENTS_FILE, encoding="utf-8") as f:
                events = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            events = []
        events.append({"ts": _now_iso(), "level": level, "text": text})
        events = events[-BOT_EVENTS_MAX:]
        tmp = BOT_EVENTS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(events, f, ensure_ascii=False)
        os.replace(tmp, BOT_EVENTS_FILE)
    except Exception:
        logger.exception("notification_service: не удалось записать bot_events.json")


class NotificationService:
    """
    Оборачивает Blogger и bot_events.json. Используется из asyncio-контекста.
    blogger может быть None — тогда шлём только в файл.
    prefix — строка-префикс для имени счёта, напр. "[Брокерский [ИИС]] ".
    """

    def __init__(self, blogger=None, prefix: str = "") -> None:
        self._blogger = blogger
        self._prefix = prefix

    def _tg(self, text: str) -> None:
        if self._blogger:
            try:
                self._blogger.notify_message(text)
            except Exception:
                logger.exception("NotificationService: ошибка отправки в TG")

    def error(self, context: str, exc: Exception | None = None, tb: str | None = None) -> None:
        """Ошибка — красный уровень. Всегда шлём в оба канала."""
        parts = [f"🔴 ОШИБКА {self._prefix}[{context}]"]
        if exc is not None:
            parts.append(repr(exc))
        if tb:
            # Обрезаем трейсбек до разумного размера для TG
            tb_short = tb.strip()[-1500:]
            parts.append(f"Traceback:\n{tb_short}")
        text = "\n".join(parts)
        _append_event("error", text)
        self._tg(text)

    def warning(self, context: str, text: str) -> None:
        msg = f"🟡 ПРЕДУПРЕЖДЕНИЕ {self._prefix}[{context}]\n{text}"
        _append_event("warning", msg)
        self._tg(msg)

    def info(self, text: str) -> None:
        msg = f"ℹ️ {self._prefix}{text}"
        _append_event("info", msg)
        self._tg(msg)

    def control(self, action: str, detail: str = "") -> None:
        """Управляющее событие (pause/resume/close/set). Только в файл, без TG-флуда."""
        msg = f"⚙️ {action}"
        if detail:
            msg += f": {detail}"
        _append_event("control", msg)


def capture_tb() -> str:
    """Возвращает текущий трейсбек как строку (вызывать из except-блока)."""
    return traceback.format_exc()
