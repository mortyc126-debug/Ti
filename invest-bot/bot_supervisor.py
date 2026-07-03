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


def status() -> dict:
    """Текущее состояние процесса бота для UI дашборда."""
    info = _read_process_info()
    if not info:
        return {"running": False, "sandbox": None, "started_at": None, "uptime_sec": None, "pid": None}
    alive = _pid_alive(info["pid"])
    uptime = None
    if alive and info.get("started_at"):
        try:
            started = datetime.datetime.fromisoformat(info["started_at"])
            uptime = (datetime.datetime.now(datetime.timezone.utc) - started).total_seconds()
        except ValueError:
            pass
    return {
        "running": alive,
        "pid": info.get("pid"),
        "sandbox": info.get("sandbox"),
        "started_at": info.get("started_at"),
        "uptime_sec": uptime,
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
