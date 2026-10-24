def max_loss_streak(pnl):
    current = best = 0
    for value in pnl:
        if value < 0:
            current += 1
            best = max(best, current)
        else:
            current = 0
    return best

print(max_loss_streak([1, -2, -1, 0, -4, -1, -3, 2]))
