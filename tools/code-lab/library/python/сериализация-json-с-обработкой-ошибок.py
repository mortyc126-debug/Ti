import json

текст = '{"тикер": "SBER", "цена": 275.4}'
try:
    данные = json.loads(текст)
except json.JSONDecodeError as ошибка:
    print("Некорректный JSON:", ошибка.msg)
else:
    print(данные.get("тикер"), данные.get("цена"))
