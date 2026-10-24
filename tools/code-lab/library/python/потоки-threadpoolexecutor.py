from concurrent.futures import ThreadPoolExecutor


def describe(value):
    return f"item:{value}"

with ThreadPoolExecutor(max_workers=3) as executor:
    results = list(executor.map(describe, [1, 2, 3]))
assert results == ["item:1", "item:2", "item:3"]
print(results)
