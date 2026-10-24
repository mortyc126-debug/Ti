from dataclasses import dataclass

@dataclass(frozen=True)
class Quote:
    ticker: str
    bid: float
    ask: float

quote = Quote("Si", 99.0, 101.0)
print(quote)
