values = [1, 2, 3, 4, 5]
squares = (value * value for value in values if value % 2 == 0)
print(sum(squares))
print(list(squares))  # генератор уже исчерпан
