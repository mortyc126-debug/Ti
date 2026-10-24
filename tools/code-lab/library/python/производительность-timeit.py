import timeit

elapsed = timeit.timeit("sum(range(100))", number=10_000)
assert elapsed > 0
print(f"10000 runs: {elapsed:.6f} seconds")
