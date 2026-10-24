from contextlib import contextmanager

@contextmanager
def ресурс():
    print("ресурс открыт")
    try:
        yield "готово"
    finally:
        print("ресурс закрыт")

with ресурс() as состояние:
    print("работа с ресурсом")
