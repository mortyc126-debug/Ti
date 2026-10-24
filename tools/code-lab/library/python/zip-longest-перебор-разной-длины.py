from itertools import zip_longest
тикеры = ["SBER", "YNDX", "LKOH"]
цены = [275.4, 4120.0]
for тикер, цена in zip_longest(тикеры, цены, fillvalue=None):
    print(тикер, цена)
