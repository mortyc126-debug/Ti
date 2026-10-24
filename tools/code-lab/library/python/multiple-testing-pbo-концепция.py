def selection_failure_rate(in_sample, out_sample):
    if len(in_sample) != len(out_sample) or not in_sample:
        raise ValueError("Нужны одинаковые непустые списки результатов")
    winner = max(range(len(in_sample)), key=in_sample.__getitem__)
    median_out = sorted(out_sample)[len(out_sample) // 2]
    return float(out_sample[winner] < median_out)

rate = selection_failure_rate([1.2, 0.8, 0.5], [0.1, 0.9, 0.4])
assert rate == 1.0
print("Победитель IS проиграл медиане OOS:", bool(rate))
