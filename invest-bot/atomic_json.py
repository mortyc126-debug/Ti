"""Атомарная запись JSON — чтобы обрыв процесса посреди записи не оставлял
битый/обрезанный файл (Зона 5 аудита: history/oi_weights/signal_gate и т.п.
теряли статистику → EWA-веса тухли в 0.5 → WR деградировал без правок кода).

Идея: пишем во ВРЕМЕННЫЙ файл в той же папке, fsync, затем os.replace на
целевой путь. os.replace атомарен в пределах одной ФС: читатель видит либо
старый файл целиком, либо новый целиком, но никогда не обрезанный.

Временное имя уникально (tempfile.mkstemp), а не фиксированный "path.tmp" —
поэтому два параллельных писателя одного файла не затирают tmp друг друга
(это же чинит concurrency-подпункт Зоны 5)."""
import json
import os
import tempfile


def atomic_write_json(path: str, data, *, ensure_ascii: bool = False,
                      indent=None, **dump_kwargs) -> None:
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp_", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=ensure_ascii, indent=indent,
                      **dump_kwargs)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        # Не оставляем висящий tmp, если запись/replace не удались.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
