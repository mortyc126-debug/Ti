from collections import deque

последние = deque(maxlen=3)
for цена in [1, 2, 3, 4, 5]:
    последние.append(цена)
print(list(последние))
