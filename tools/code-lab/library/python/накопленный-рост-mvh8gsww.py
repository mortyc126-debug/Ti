returns = [0.05, -0.02, 0.03]

total = 1.0
for r in returns:
    total *= 1 + r

print(total - 1)