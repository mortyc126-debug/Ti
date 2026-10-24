from functools import wraps
from time import perf_counter, sleep

def измерить_время(функция):
    @wraps(функция)
    def обёртка(*args, **kwargs):
        начало = perf_counter()
        try:
            return функция(*args, **kwargs)
        finally:
            print(f"{функция.__name__}: {perf_counter() - начало:.4f} с")
    return обёртка

@измерить_время
def пример():
    sleep(0.01)

пример()
