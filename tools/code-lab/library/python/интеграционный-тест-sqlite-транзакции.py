import sqlite3

con = sqlite3.connect(":memory:")
con.execute("CREATE TABLE ledger (amount INTEGER NOT NULL)")
try:
    with con:
        con.execute("INSERT INTO ledger VALUES (10)")
        con.execute("INSERT INTO ledger VALUES (20)")
    assert con.execute("SELECT SUM(amount) FROM ledger").fetchone()[0] == 30
    try:
        with con:
            con.execute("INSERT INTO ledger VALUES (30)")
            raise RuntimeError("имитация сбоя")
    except RuntimeError:
        pass
    assert con.execute("SELECT SUM(amount) FROM ledger").fetchone()[0] == 30
    print("Commit и rollback проверены")
finally:
    con.close()
