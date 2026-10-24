from math import sqrt


def annualized_sharpe(returns, risk_free_per_period=0.0, periods_per_year=252):
    if periods_per_year <= 0:
        raise ValueError("periods_per_year должен быть положительным")
    excess = [r - risk_free_per_period for r in returns]
    if len(excess) < 2:
        raise ValueError("Нужно минимум два наблюдения")
    mean = sum(excess) / len(excess)
    variance = sum((x - mean) ** 2 for x in excess) / (len(excess) - 1)
    std = sqrt(variance)
    if std == 0:
        raise ValueError("Нулевая волатильность: Sharpe не определён")
    return mean / std * sqrt(periods_per_year)

print(round(annualized_sharpe([0.01, -0.002, 0.004, 0.003]), 4))
