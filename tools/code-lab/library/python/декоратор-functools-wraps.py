from functools import wraps

def announce(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        return func(*args, **kwargs)
    return wrapper

@announce
def calculate(x):
    """Return x squared."""
    return x * x

assert calculate(3) == 9
assert calculate.__name__ == "calculate"
assert calculate.__doc__ == "Return x squared."
print(calculate.__name__, calculate.__doc__)
