from queue import Queue
from threading import Thread

jobs = Queue()
results = []

def worker():
    while True:
        item = jobs.get()
        try:
            if item is None:
                return
            results.append(item * 2)
        finally:
            jobs.task_done()

thread = Thread(target=worker)
thread.start()
for value in (1, 2, 3):
    jobs.put(value)
jobs.put(None)
jobs.join()
thread.join()
assert sorted(results) == [2, 4, 6]
print(sorted(results))
