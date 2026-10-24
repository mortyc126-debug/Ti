from concurrent.futures import ProcessPoolExecutor


def square(value):
    return value * value


if __name__ == "__main__":
    with ProcessPoolExecutor(max_workers=2) as executor:
        result = list(executor.map(square, [1, 2, 3, 4]))
    assert result == [1, 4, 9, 16]
    print(result)
