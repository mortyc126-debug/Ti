import math
import pytest

def простая_доходность(старая, новая):
    if not math.isfinite(старая) or not math.isfinite(новая) or старая <= 0 or новая <= 0:
        raise ValueError("Цены должны быть конечными и положительными")
    return новая / старая - 1

def максимальная_просадка(капитал):
    if not капитал or any(not math.isfinite(x) or x <= 0 for x in капитал):
        raise ValueError("Капитал должен быть непустым, конечным и положительным")
    пик = капитал[0]
    худшая = 0.0
    for x in капитал:
        пик = max(пик, x)
        худшая = min(худшая, x / пик - 1)
    return худшая

def var_по_ближайшему_рангу(доходности, уровень):
    from math import ceil
    if not доходности or any(not math.isfinite(r) or r < -1 for r in доходности):
        raise ValueError("Нужны конечные доходности не меньше -100%")
    if not math.isfinite(уровень) or not 0 < уровень < 1:
        raise ValueError("Уровень должен находиться между 0 и 1")
    отсортированные = sorted(доходности)
    индекс = max(0, ceil(len(отсортированные) * (1 - уровень)) - 1)
    return -отсортированные[индекс]

def риск_портфеля(w1, w2, s1, s2, rho):
    значения = (w1, w2, s1, s2, rho)
    if not all(math.isfinite(x) for x in значения):
        raise ValueError("Параметры должны быть конечными")
    if s1 < 0 or s2 < 0 or not -1 <= rho <= 1:
        raise ValueError("Недопустимая волатильность или корреляция")
    if not math.isclose(w1 + w2, 1.0, abs_tol=1e-9):
        raise ValueError("Веса должны суммироваться до 1")
    variance = (w1 * s1) ** 2 + (w2 * s2) ** 2 + 2 * w1 * w2 * s1 * s2 * rho
    return math.sqrt(max(variance, 0.0))

def test_простая_доходность():
    assert простая_доходность(100, 110) == pytest.approx(0.1)

def test_просадка():
    assert максимальная_просадка([100, 120, 90, 110]) == pytest.approx(-0.25)

def test_цена_ноль_ошибка():
    with pytest.raises(ValueError):
        простая_доходность(0, 100)

def test_var_на_малой_выборке():
    доходности = [-0.03, 0.01, -0.01, 0.02, -0.05, 0.015, 0.0, -0.02, 0.03, 0.005]
    assert var_по_ближайшему_рангу(доходности, 0.95) == pytest.approx(0.05)

def test_риск_портфеля():
    assert риск_портфеля(0.6, 0.4, 0.2, 0.1, 0.3) == pytest.approx(0.1374045123)

def test_совокупная_доходность():
    assert (1 + 0.10) * (1 - 0.10) - 1 == pytest.approx(-0.01)
