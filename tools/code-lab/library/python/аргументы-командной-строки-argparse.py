import argparse

парсер = argparse.ArgumentParser(description="Посчитать стоимость позиции")
парсер.add_argument("цена", type=float, help="цена одной единицы")
парсер.add_argument("количество", type=int, help="количество единиц")
аргументы = парсер.parse_args(["100.5", "3"])  # для демонстрации без терминала
print(аргументы.цена * аргументы.количество)
