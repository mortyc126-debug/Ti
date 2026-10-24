def fit_ols_with_hac(y, X, maxlags=1):
    if maxlags < 0:
        raise ValueError("maxlags должен быть неотрицательным")
    try:
        import statsmodels.api as sm
    except ImportError as exc:
        raise RuntimeError("Установите statsmodels для HAC/Newey–West") from exc
    model = sm.OLS(y, X).fit(cov_type="HAC", cov_kwds={"maxlags": maxlags})
    return model

print("HAC пример готов; для расчёта нужен statsmodels и согласованные y/X")
