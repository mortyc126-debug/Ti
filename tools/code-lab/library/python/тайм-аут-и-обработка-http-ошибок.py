from urllib.request import urlopen
from urllib.error import HTTPError, URLError

url = "https://api.example.com/data"  # замените адресом реального API
try:
    with urlopen(url, timeout=5) as ответ:
        тело = ответ.read().decode("utf-8")
        print(ответ.status, тело[:200])
except HTTPError as ошибка:
    print("HTTP-ошибка:", ошибка.code)
except (URLError, TimeoutError) as ошибка:
    print("Сетевая ошибка:", ошибка)
