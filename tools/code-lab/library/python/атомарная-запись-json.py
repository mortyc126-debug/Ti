import json
import os
from pathlib import Path
from tempfile import NamedTemporaryFile


def atomic_write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_name = None
    try:
        with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                delete=False, suffix=".tmp") as stream:
            temp_name = stream.name
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)

with __import__("tempfile").TemporaryDirectory() as directory:
    target = Path(directory) / "state.json"
    atomic_write_json(target, {"ok": True})
    assert json.loads(target.read_text(encoding="utf-8")) == {"ok": True}
    print(target.exists())
