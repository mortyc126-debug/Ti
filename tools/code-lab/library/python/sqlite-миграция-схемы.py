import sqlite3

connection = sqlite3.connect(":memory:")
try:
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    if version < 1:
        with connection:
            connection.execute("CREATE TABLE prices (symbol TEXT PRIMARY KEY, price REAL NOT NULL)")
            connection.execute("PRAGMA user_version = 1")
    assert connection.execute("PRAGMA user_version").fetchone()[0] == 1
    connection.execute("INSERT INTO prices VALUES (?, ?)", ("ABC", 10.5))
    print(connection.execute("SELECT symbol, price FROM prices").fetchone())
finally:
    connection.close()
