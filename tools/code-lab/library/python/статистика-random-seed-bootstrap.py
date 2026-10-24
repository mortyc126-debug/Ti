import random

rng = random.Random(42)
values = [1.0, 2.0, 3.0, 4.0]
sample = [rng.choice(values) for _ in values]
print(sample)
