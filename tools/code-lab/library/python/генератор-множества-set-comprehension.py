numbers = [1, 2, 2, 3, 4, 4, 5]
even_squares = {n * n for n in numbers if n % 2 == 0}
print(sorted(even_squares))
