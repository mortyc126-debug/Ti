def can_trade(is_open, has_data, risk_ok):
    return is_open and has_data and risk_ok

print(can_trade(True, True, False))
print(not (False or True))
# and/or возвращают один из операндов, а не обязательно bool.
print("" or "резервное значение")
