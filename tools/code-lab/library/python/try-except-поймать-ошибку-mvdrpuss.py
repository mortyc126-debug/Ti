текст = "abc"

try:
    число = float(текст)
except ValueError:
    print("не число")
    число = None
finally:
    print("проверка закончена")