prices = [10, 11, 12, 11, 13, 14]
window = 3

moving = [
    sum(prices[i - window + 1:i + 1]) / window
    for i in range(window - 1, len(prices))
]
print(moving)
