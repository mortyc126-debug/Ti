import sqlite3

con = sqlite3.connect(":memory:")
con.execute("PRAGMA foreign_keys = ON")
con.execute("CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)")
con.execute("CREATE TABLE trades (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), qty INTEGER NOT NULL CHECK(qty > 0))")
con.execute("INSERT INTO accounts(name) VALUES (?)", ("main",))
try:
    con.execute("INSERT INTO trades(account_id, qty) VALUES (?, ?)", (1, 0))
except sqlite3.IntegrityError:
    print("Нарушение ограничения обнаружено")
else:
    raise AssertionError("CHECK(qty > 0) не сработал")
con.close()
