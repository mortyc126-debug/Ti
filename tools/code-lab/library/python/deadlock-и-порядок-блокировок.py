from threading import Lock

lock_a = Lock()
lock_b = Lock()

# Соглашение: сначала lock_a, затем lock_b во всех участках программы.
with lock_a:
    with lock_b:
        result = "locks acquired in canonical order"

assert result.endswith("canonical order")
print(result)
