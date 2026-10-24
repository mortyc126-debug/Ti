from collections import defaultdict

инструменты = [("MOEX", "Si"), ("NYSE", "AAPL"), ("MOEX", "RI")]
по_бирже = defaultdict(list)
for биржа, тикер in инструменты:
    по_бирже[биржа].append(тикер)
print(dict(по_бирже))
