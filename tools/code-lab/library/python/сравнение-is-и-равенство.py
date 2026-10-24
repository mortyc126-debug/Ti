# == сравнивает значения, is проверяет идентичность объектов
a = [1, 2]
b = [1, 2]
c = a
print(a == b)  # True: содержимое одинаковое
print(a is b)  # False: это разные списки
print(a is c)  # True: обе переменные ссылаются на один объект
value = None
print(value is None)
