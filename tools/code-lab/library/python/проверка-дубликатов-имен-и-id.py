import json
from collections import defaultdict
from pathlib import Path


def duplicates(directory: Path):
    by_id, by_title = defaultdict(list), defaultdict(list)
    for path in directory.glob("*.py.meta.json"):
        meta = json.loads(path.read_text(encoding="utf-8"))
        if meta.get("id"):
            by_id[meta["id"]].append(path.name)
        if meta.get("title"):
            by_title[meta["title"].strip().casefold()].append(path.name)
    return ({k:v for k,v in by_id.items() if len(v)>1},
            {k:v for k,v in by_title.items() if len(v)>1})

with __import__("tempfile").TemporaryDirectory() as tmp:
    d = Path(tmp)
    for i in range(2):
        (d / f"{i}.py.meta.json").write_text(json.dumps({"id":"same","title":"Same title"}), encoding="utf-8")
    ids, titles = duplicates(d)
    assert "same" in ids and "same title" in titles
print("Поиск дубликатов проверен")
