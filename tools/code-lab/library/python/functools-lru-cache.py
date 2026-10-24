from functools import lru_cache

@lru_cache(maxsize=None)
def фибоначчи(n):
    if n < 0:
        raise ValueError("n должно быть неотрицательным")
    if n < 2:
        return n
    return фибоначчи(n - 1) + фибоначчи(n - 2)

print(фибоначчи(10))
