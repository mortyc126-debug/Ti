prices = {"акция": 125.5, "фьючерс": 126.0, "облигация": 98.7}
percent = {name: round(price / 100, 3) for name, price in prices.items() if price < 127}
print(percent)
