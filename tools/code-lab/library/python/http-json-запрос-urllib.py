import json
from urllib.request import Request, urlopen


def post_json(url, payload, timeout=5):
    body = json.dumps(payload).encode("utf-8")
    request = Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))

# Пример вызова: post_json("https://example.invalid/api", {"symbol": "SBER"})
