"""
bot_supervisor.py — старт/стоп/статус процесса main.py с дашборда.

dashboard.py и main.py — два независимых процесса без общего event loop, поэтому
управление реализовано через subprocess + PID-файл (data/bot_process.json) +
уже существующий канал data/bot_overrides.json (runtime_overrides.py) для
мягкой остановки: stop_bot() только выставляет shutdown_requested и сразу
возвращается — main.py сам завершает себя, увидев флаг на очередной свече
(trading/trader.py::BotShutdownRequested). Дашборд поллит status(), пока
running не станет false; если бот в этот момент не в торговом цикле (ночной/
выходной sleep — trading/trade_service.py::__sleep_to_next_morning, overrides
там не читаются) — UI предлагает force_kill_bot().

Не тянет psutil — кроссплатформенная проверка живости процесса и force-kill
сделаны через os.kill (POSIX) / tasklist+taskkill (Windows), см. _pid_alive/
_force_kill ниже.
"""
import datetime
import json
import logging
import os
import re
import subprocess
import sys

import runtime_overrides

logger = logging.getLogger(__name__)

PROCESS_FILE = "data/bot_process.json"
LOG_FILE = "data/bot_run.log"
MAIN_SCRIPT = "main.py"


def _read_process_info() -> dict | None:
    if not os.path.exists(PROCESS_FILE):
        return None
    try:
        with open(PROCESS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _write_process_info(info: dict | None) -> None:
    os.makedirs(os.path.dirname(PROCESS_FILE) or ".", exist_ok=True)
    tmp = PROCESS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)
    os.replace(tmp, PROCESS_FILE)


def _pid_alive(pid: int) -> bool:
    if os.name == "nt":
        try:
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, timeout=10,
            )
            return str(pid) in out.stdout
        except Exception as e:
            logger.warning(f"bot_supervisor: tasklist упал: {e}")
            return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # процесс есть, просто не наш — всё равно "жив"
    except OSError:
        return False


def _force_kill(pid: int) -> bool:
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=10)
            return True
        except Exception as e:
            logger.warning(f"bot_supervisor: taskkill упал: {e}")
            return False
    import signal
    try:
        os.kill(pid, signal.SIGKILL)
        return True
    except OSError as e:
        logger.warning(f"bot_supervisor: SIGKILL упал: {e}")
        return False


def _parse_phase_from_log(tail_lines: list[str]) -> dict:
    """Определяет фазу работы бота из последних строк bot_run.log.

    Возвращает {phase, phase_msg, sleep_until_iso}. Фазы:
    - "trading" — торговая сессия идёт (последнее событие Trading day started).
    - "waiting_open" — торговый день, ждём открытия сессии (Trading will start after X).
    - "sleeping_night" — не торговый день/сессия кончилась, спим до утра.
    - "starting" — только-только стартанул, ещё не дошёл до расписания.
    - "unknown" — не смогли определить (лог пустой/старый формат).

    Логика на маркерах, а не regex: строки лога стабильные,
    Sleep to next morning / Today is trading day и т.п. — всё
    trade_service.py::__working_loop. sleep_until в UTC.
    """
    result = {"phase": "unknown", "phase_msg": None, "sleep_until_iso": None}

    # start_time от Tinkoff API форматируется как datetime.__str__ —
    # «2026-07-06 07:00:00+00:00» (с пробелом внутри). Захватываем до конца
    # строки, потом чистим trailing whitespace.
    waiting_re = re.compile(r"Today is trading day\. Trading will start after (.+)$")

    def _wake_next_morning_iso() -> str:
        tomorrow = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1)
        return tomorrow.replace(hour=6, minute=0, second=0, microsecond=0).isoformat()

    # Смотрим ТОЛЬКО последнюю итерацию цикла (после последнего
    # «Check trading schedule on today») — более старые нерелевантны.
    # Прежняя версия шла с конца и первой же ловила «Sleep to next morning»,
    # который логируется в КОНЦЕ ЛЮБОЙ ветки (ошибка/не-торговый-день/день
    # завершён) → фаза ВСЕГДА показывалась «сессия закончилась», настоящая
    # причина маскировалась. Теперь классифицируем по тому, ЧТО реально было в
    # последней итерации, а не по последней строке.
    last_check = -1
    for i, line in enumerate(tail_lines):
        if "Check trading schedule on today" in line:
            last_check = i
    window = tail_lines[last_check:] if last_check >= 0 else tail_lines

    started = any("Trading day has been started" in l for l in window)
    completed = any("Trading day has been completed" in l for l in window)
    not_trading = any("Today is not trading day" in l for l in window)
    errored = any("Start trading today error" in l for l in window)
    slept = any("Sleep to next morning" in l for l in window)
    waiting_line = next((l for l in reversed(window) if waiting_re.search(l)), None)

    # Приоритет: активная торговля > ошибка > не-торговый-день > день завершён >
    # ждём открытия > провалились в сон > только стартовали.
    if started and not slept:
        result["phase"] = "trading"
        result["phase_msg"] = "торговая сессия"
    elif errored:
        # Раньше это выглядело как «сессия закончилась» — теперь видно, что
        # старт торговли упал (расписание/API/стратегии), и бот спит до утра.
        result["phase"] = "error"
        result["phase_msg"] = "ошибка старта торговли — бот спит до утра (смотри лог)"
        result["sleep_until_iso"] = _wake_next_morning_iso()
    elif not_trading:
        result["phase"] = "sleeping_night"
        result["phase_msg"] = "не торговый день (выходной/праздник), спит до утра"
        result["sleep_until_iso"] = _wake_next_morning_iso()
    elif completed:
        result["phase"] = "waiting_open"
        result["phase_msg"] = "торговый день завершён, ждём завтра"
        result["sleep_until_iso"] = _wake_next_morning_iso()
    elif waiting_line is not None:
        raw = waiting_re.search(waiting_line).group(1).strip()
        iso = raw.replace(" ", "T", 1) if " " in raw else raw
        result["phase"] = "waiting_open"
        result["phase_msg"] = f"торговый день, откроется {raw}"
        result["sleep_until_iso"] = iso
    elif slept:
        result["phase"] = "sleeping_night"
        result["phase_msg"] = "сессия закончилась, спит до утра"
        result["sleep_until_iso"] = _wake_next_morning_iso()
    elif last_check >= 0:
        result["phase"] = "starting"
        result["phase_msg"] = "получаю расписание МОЕХ"
    return result


def _read_log_tail(n: int = 200) -> list[str]:
    """Читает последние N строк bot_run.log. При отсутствии/ошибке возвращает []."""
    if not os.path.exists(LOG_FILE):
        return []
    try:
        with open(LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
            # Простой хвост — файл обычно небольшой (<10 МБ). При росте
            # можно перейти на mmap+seek, но пока не нужно.
            lines = f.readlines()
    except OSError:
        return []
    return lines[-n:]


def status() -> dict:
    """Текущее состояние процесса бота для UI дашборда."""
    info = _read_process_info()
    if not info:
        return {"running": False, "sandbox": None, "started_at": None,
                 "uptime_sec": None, "pid": None,
                 "phase": None, "phase_msg": None, "sleep_until_iso": None}
    alive = _pid_alive(info["pid"])
    uptime = None
    if alive and info.get("started_at"):
        try:
            started = datetime.datetime.fromisoformat(info["started_at"])
            uptime = (datetime.datetime.now(datetime.timezone.utc) - started).total_seconds()
        except ValueError:
            pass
    # Фазу считаем только если бот сейчас живой — иначе бессмысленно.
    phase_info = {"phase": None, "phase_msg": None, "sleep_until_iso": None}
    if alive:
        phase_info = _parse_phase_from_log(_read_log_tail(200))
    return {
        "running": alive,
        "pid": info.get("pid"),
        "sandbox": info.get("sandbox"),
        "started_at": info.get("started_at"),
        "uptime_sec": uptime,
        **phase_info,
    }


def start_bot(sandbox: bool) -> dict:
    """Запускает main.py как отдельный процесс. Возвращает {"ok": bool, ...}."""
    current = status()
    if current["running"]:
        return {"ok": False, "error": f"бот уже запущен (PID {current['pid']}) — сначала останови"}

    # Защита от протухшего shutdown_requested с прошлой сессии — иначе новый
    # процесс увидит флаг на первой же свече и тут же завершится сам.
    data = runtime_overrides.load_overrides()
    if data.get("shutdown_requested"):
        data["shutdown_requested"] = False
        runtime_overrides.save_overrides(data)

    bot_dir = os.path.dirname(os.path.abspath(__file__))
    env = dict(os.environ)
    env["TINKOFF_SANDBOX"] = "1" if sandbox else "0"

    os.makedirs(os.path.dirname(LOG_FILE) or ".", exist_ok=True)
    log_f = open(LOG_FILE, "a", encoding="utf-8")
    log_f.write(f"\n\n===== старт {datetime.datetime.now().isoformat()} sandbox={sandbox} =====\n")
    log_f.flush()

    popen_kwargs = dict(
        cwd=bot_dir,
        env=env,
        stdout=log_f,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
    )
    if os.name == "nt":
        popen_kwargs["creationflags"] = (
            subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
        )
    else:
        popen_kwargs["start_new_session"] = True

    try:
        proc = subprocess.Popen([sys.executable, MAIN_SCRIPT], **popen_kwargs)
    except OSError as e:
        return {"ok": False, "error": f"не удалось запустить процесс: {e}"}

    _write_process_info({
        "pid": proc.pid,
        "sandbox": sandbox,
        "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "python": sys.executable,
    })
    logger.info(f"bot_supervisor: main.py запущен, PID={proc.pid}, sandbox={sandbox}")
    return {"ok": True, "pid": proc.pid, "sandbox": sandbox}


def stop_bot() -> dict:
    """Мягкая остановка: только выставляет shutdown_requested и возвращается
    сразу — main.py читает флаг на очередной свече (обычно секунды) и
    завершается сам. НЕ блокирует HTTP-поток дашборда ожиданием: клиент сам
    поллит /api/supervisor/status, пока running не станет false. Если бот в
    этот момент не в торговом цикле (ночной/выходной sleep между сессиями —
    trading/trade_service.py::__sleep_to_next_morning), флаг не читается —
    статус останется running=true, тогда решение за пользователем
    (force_kill_bot)."""
    current = status()
    if not current["running"]:
        _write_process_info(None)
        return {"ok": True, "already_stopped": True}

    data = runtime_overrides.load_overrides()
    data["shutdown_requested"] = True
    runtime_overrides.save_overrides(data)
    logger.info(f"bot_supervisor: запрошена мягкая остановка PID {current['pid']}")
    return {"ok": True, "requested": True, "pid": current["pid"]}


def force_kill_bot() -> dict:
    current = status()
    if not current["running"]:
        _write_process_info(None)
        return {"ok": True, "already_stopped": True}
    killed = _force_kill(current["pid"])
    _write_process_info(None)
    return {"ok": killed, "pid": current["pid"]}


def tail_log(n_lines: int = 200) -> str:
    if not os.path.exists(LOG_FILE):
        return ""
    try:
        with open(LOG_FILE, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        return "".join(lines[-n_lines:])
    except OSError:
        return ""
