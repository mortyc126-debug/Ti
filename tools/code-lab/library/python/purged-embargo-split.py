def purge_overlapping(train_intervals, test_intervals, embargo=0):
    if embargo < 0:
        raise ValueError("embargo не может быть отрицательным")
    kept = []
    for start, end, item in train_intervals:
        overlaps = any(start <= test_end + embargo and end >= test_start
                       for test_start, test_end in test_intervals)
        if not overlaps:
            kept.append(item)
    return kept

train = [(0, 2, "a"), (3, 5, "b"), (8, 9, "c")]
test = [(4, 6)]
assert purge_overlapping(train, test) == ["a", "c"]
assert purge_overlapping(train, test, embargo=2) == ["a"]
print("Перекрывающиеся интервалы исключены")
