def walk_forward_splits(n, test_size, min_train_size):
    if n <= 0 or test_size <= 0 or min_train_size <= 0:
        raise ValueError("Размеры должны быть положительными")
    start = min_train_size
    while start + test_size <= n:
        yield (0, start, start, start + test_size)
        start += test_size

print(list(walk_forward_splits(n=10, test_size=2, min_train_size=6)))
