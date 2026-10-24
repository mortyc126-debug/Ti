import sqlite3

with sqlite3.connect(":memory:") as con:
    con.execute("CREATE TABLE trades (id INTEGER PRIMARY KEY, pnl REAL)")
    con.execute("INSERT INTO trades (pnl) VALUES (?)", (12.5,))
    con.execute("INSERT INTO trades (pnl) VALUES (?)", (-3.0,))
    rows = con.execute("SELECT pnl FROM trades ORDER BY id").fetchall()
    print(rows)
