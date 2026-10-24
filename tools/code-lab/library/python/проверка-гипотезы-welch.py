from scipy.stats import ttest_ind

before = [0.01, 0.02, -0.01, 0.00, 0.015]
after = [0.03, 0.04, 0.02, -0.005, 0.035]
result = ttest_ind(after, before, equal_var=False)
print({"statistic": float(result.statistic), "pvalue": float(result.pvalue)})
