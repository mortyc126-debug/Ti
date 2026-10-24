class Инструмент:
    def __init__(self, тикер):
        self.тикер = тикер

    def описание(self):
        return self.тикер

class Фьючерс(Инструмент):
    def __init__(self, тикер, экспирация):
        super().__init__(тикер)
        self.экспирация = экспирация

    def описание(self):
        return f"{super().описание()}: фьючерс"

print(Фьючерс("Si", "2026-12").описание())
