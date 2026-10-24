def execution_cost_bps(mid_price: float, fill_price: float, fee_bps: float = 0.0) -> float:
    if mid_price <= 0 or fill_price <= 0 or fee_bps < 0:
        raise ValueError("Цены должны быть положительными, комиссия неотрицательной")
    adverse_move_bps = abs(fill_price - mid_price) / mid_price * 10_000
    return adverse_move_bps + fee_bps

buy_cost = execution_cost_bps(100.0, 100.04, fee_bps=1.0)
assert round(buy_cost, 4) == 5.0
print("Издержки, bps:", round(buy_cost, 4))
