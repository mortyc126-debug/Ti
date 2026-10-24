def net_return(gross_return: float, entry_fee: float, exit_fee: float, slippage: float) -> float:
    return gross_return - entry_fee - exit_fee - slippage

print(net_return(0.012, 0.0005, 0.0005, 0.001))
