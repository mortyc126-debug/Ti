from unittest.mock import Mock


def get_price(client, symbol: str) -> float:
    response = client.get("/price", params={"symbol": symbol}, timeout=2.0)
    response.raise_for_status()
    return float(response.json()["price"])

client = Mock()
response = client.get.return_value
response.json.return_value = {"price": "12.5"}
assert get_price(client, "ABC") == 12.5
client.get.assert_called_once_with("/price", params={"symbol": "ABC"}, timeout=2.0)
response.raise_for_status.assert_called_once_with()
print("HTTP-вызов проверен без сети")
