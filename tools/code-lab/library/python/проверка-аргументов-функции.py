def make_range(start, stop):
    if not isinstance(start, int) or not isinstance(stop, int):
        raise TypeError("Границы должны быть целыми числами")
    if stop < start:
        raise ValueError("stop должен быть не меньше start")
    return list(range(start, stop))

assert make_range(2, 5) == [2, 3, 4]
