def append_value(value, items=None):
    if items is None:
        items = []
    items.append(value)
    return items

first = append_value(1)
second = append_value(2)
assert first == [1]
assert second == [2]
print(first, second)
