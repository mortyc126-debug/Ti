import json


def load_config(text: str) -> dict:
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("Корнем конфигурации должен быть объект")
    timeout = data.get("timeout_seconds")
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or timeout <= 0:
        raise ValueError("timeout_seconds должен быть положительным числом")
    return data

print(load_config('{"timeout_seconds": 5}') ["timeout_seconds"])
