def broken_add(value, items=[]):
    items.append(value)
    return items

def safe_add(value, items=None):
    if items is None:
        items = []
    items.append(value)
    return items

print(broken_add(1))
print(broken_add(2))  # тот же список
print(safe_add(1))
print(safe_add(2))    # новый список
