from urllib.parse import urlencode, urlunparse

params = {"symbol": "IMOEX", "note": "цена и объём"}
query = urlencode(params)
url = f"https://example.com/search?{query}"
print(url)
