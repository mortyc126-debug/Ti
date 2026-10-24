from urllib.request import Request, urlopen
from urllib.error import URLError


def fetch_status(url: str, timeout: float = 3.0) -> int:
    request = Request(url, method="GET")
    with urlopen(request, timeout=timeout) as response:
        return response.status

# Сетевой вызов намеренно не выполняется при импорте.
print("Функция готова; тайм-аут по умолчанию:", 3.0)
