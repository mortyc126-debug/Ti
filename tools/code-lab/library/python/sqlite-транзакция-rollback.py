import sqlite3

connection = sqlite3.connect(":memory:")
try:
    connection.execute("CREATE TABLE trades (id INTEGER PRIMARY KEY, qty INTEGER CHECK(qty > 0))")
    try:
        with connection:
            connection.execute("INSERT INTO trades(qty) VALUES (?)", (3,))
            connection.execute("INSERT INTO trades(qty) VALUES (?)", (-1,))
    except sqlite3.IntegrityError:
        pass
    count = connection.execute("SELECT COUNT(*) FROM trades").fetchone()[0]
    assert count == 0
    print("rows after rollback:", count)
finally:
    connection.close()
