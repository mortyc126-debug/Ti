from concurrent.futures import ProcessPoolExecutor

def square(value):
    return value * value

if __name__ == "__main__":
    with ProcessPoolExecutor(max_workers=2) as pool:
        print(list(pool.map(square, [1, 2, 3, 4])))
