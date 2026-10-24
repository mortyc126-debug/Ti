from typing import Protocol

class Котируемый(Protocol):
    тикер: str
    def mid_price(self) -> float: ...

class Котировка:
    def __init__(self, тикер: str, bid: float, ask: float):
        self.тикер = тикер
        self.bid = bid
        self.ask = ask

    def mid_price(self) -> float:
        return (self.bid + self.ask) / 2

def показать(инструмент: Котируемый) -> str:
    return инструмент.тикер

print(показать(Котировка("Si", 99.0, 101.0)))
