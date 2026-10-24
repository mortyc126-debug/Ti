from dataclasses import dataclass

@dataclass
class Облигация:
    имя: str
    купон: float
    лет: int = 5

б = Облигация("ОФЗ", 7.5)
print(б)
print(б.купон)