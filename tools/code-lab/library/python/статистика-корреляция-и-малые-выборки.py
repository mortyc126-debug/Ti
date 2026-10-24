import math

def pearson_corr(xs, ys):
    pairs = [(float(x), float(y)) for x, y in zip(xs, ys, strict=True)
             if math.isfinite(float(x)) and math.isfinite(float(y))]
    if len(pairs) < 3:
        raise ValueError("Нужно минимум три конечные парные точки")
    x = [a for a, _ in pairs]; y = [b for _, b in pairs]
    mx = sum(x) / len(x); my = sum(y) / len(y)
    dx = [v - mx for v in x]; dy = [v - my for v in y]
    denom = math.sqrt(sum(v*v for v in dx) * sum(v*v for v in dy))
    if denom == 0:
        raise ValueError("Корреляция не определена при нулевой дисперсии")
    return sum(a*b for a, b in zip(dx, dy)) / denom

print(round(pearson_corr([1, 2, 3, 4], [2, 1, 4, 3]), 4))
