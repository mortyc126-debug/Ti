from concurrent.futures import ThreadPoolExecutor
from threading import Lock

counter = 0
lock = Lock()

def increment_many(n):
    global counter
    for _ in range(n):
        with lock:
            counter += 1

with ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(increment_many, [1000] * 4))
print(counter)
