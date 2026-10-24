prices = [100, 105, 102, 110]

if any(price <= 0 for price in prices):
    raise ValueError("Для расчёта доходности цены должны быть положительными")

returns = [(new - old) / old for old, new in zip(prices, prices[1:])]
print(returns)
