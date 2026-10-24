def simple_return(prices):
    """Рассчитать простые доходности последовательных цен.

    Args:
        prices: Цены в хронологическом порядке.

    Returns:
        Список доходностей между соседними ценами.
    """
    return [current / previous - 1 for previous, current in zip(prices, prices[1:])]

print(simple_return([100, 110, 99]))
print(simple_return.__doc__.splitlines()[0])
