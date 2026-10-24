import sqlite3

with sqlite3.connect(":memory:") as соединение:
    соединение.execute("CREATE TABLE цены (тикер TEXT, цена REAL)")
    соединение.execute("INSERT INTO цены VALUES (?, ?)", ("SBER", 275.4))
    строки = соединение.execute(
        "SELECT тикер, цена FROM цены WHERE цена > ?", (200,)
    ).fetchall()
    print(строки)
