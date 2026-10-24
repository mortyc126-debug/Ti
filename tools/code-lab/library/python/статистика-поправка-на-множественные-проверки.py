def bonferroni(p_values, alpha=0.05):
    if not 0 < alpha < 1:
        raise ValueError("alpha должен быть между 0 и 1")
    m = len(p_values)
    if m == 0:
        return []
    threshold = alpha / m
    return [(p, p <= threshold) for p in p_values]

print(bonferroni([0.01, 0.03, 0.20], alpha=0.05))
