rate = 10  # Global
def outer():
    rate = 20  # Enclosing
    def inner():
        rate = 30  # Local
        print(rate)
    inner()
    print(rate)
outer()
print(rate)
