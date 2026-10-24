from itertools import groupby

строки = [("A", 1), ("A", 3), ("B", 2)]
группы = [(ключ, [значение for _, значение in группа])
          for ключ, группа in groupby(строки, key=lambda x: x[0])]
print(группы)
