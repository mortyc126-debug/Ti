import math

class Инструмент:
    def __init__(self, тикер, цена):
        self.тикер = тикер
        self.цена = цена

    @property
    def цена(self):
        return self._цена

    @цена.setter
    def цена(self, значение):
        значение = float(значение)
        if not math.isfinite(значение) or значение <= 0:
            raise ValueError("Цена должна быть конечной и положительной")
        self._цена = значение

инструмент = Инструмент("Si", 125)
print(инструмент.цена)
