from math import sqrt

def sortino(returns, target=0.0):
    if not returns:
        raise ValueError("Нужны наблюдения")
    downside_sq = [min(r - target, 0.0) ** 2 for r in returns]
    downside_deviation = sqrt(sum(downside_sq) / len(returns))
    if downside_deviation == 0:
        return float("inf") if sum(returns) / len(returns) > target else float("nan")
    return (sum(returns) / len(returns) - target) / downside_deviation

print(round(sortino([0.01, -0.02, 0.015, 0.005]), 4))
