from decimal import Decimal, ROUND_HALF_UP

a = Decimal("0.1")
b = Decimal("0.2")
print(a + b)
amount = Decimal("12.345").quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
print(amount)
