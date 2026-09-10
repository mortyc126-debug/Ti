"""make_smoke_data.py — СИНТЕТИЧЕСКИЕ данные-«дымоход» для earnings_drift.py.

Назначение — проверить, что конвейер запускается и не течёт, НЕ проверить
гипотезу. Данные — чистый шум: сигнала в отчётности нет по построению,
поэтому OOS-метрики fundamentals/interaction должны быть около нуля
(r2_vs_zero ≈ 0, spearman_ic ≈ 0). Если тут «находится» сигнал — это баг/утечка.

Пишет daily.csv и events.csv рядом. Затем: py -3.11 earnings_drift.py
"""
from __future__ import annotations

import numpy as np
import pandas as pd

rng = np.random.default_rng(42)

N_TICKERS = 40
N_SESSIONS = 650          # ~2.5 года торговых дней
EVENTS_PER_TICKER = 6
FIRST_EVENT_AT = 150      # чтобы хватало истории (min_factor_obs=120)
EVENT_STEP = 63           # ~квартал

tickers = [f"S{i:02d}" for i in range(N_TICKERS)]
dates = pd.bdate_range("2021-01-04", periods=N_SESSIONS, tz="UTC")

# Общие факторы на дату (рынок и валюта — общие, сектор сделаем по бумаге).
mkt = rng.normal(0, 0.010, N_SESSIONS)
fx = rng.normal(0, 0.004, N_SESSIONS)

daily_rows = []
for tk in tickers:
    b_mkt = rng.normal(1.0, 0.3)
    b_sec = rng.normal(0.5, 0.2)
    b_fx = rng.normal(0.0, 0.3)
    sector = rng.normal(0, 0.008, N_SESSIONS)          # отраслевой фактор
    eps = rng.normal(0, 0.012, N_SESSIONS)             # идиосинкразия (шум)
    log_ret = b_mkt * mkt + b_sec * sector + b_fx * fx + eps
    for i in range(N_SESSIONS):
        daily_rows.append({
            "ticker": tk,
            "close_time": dates[i].strftime("%Y-%m-%dT15:45:00Z"),
            "log_ret": round(float(log_ret[i]), 6),
            "mkt": round(float(mkt[i]), 6),
            "sector": round(float(sector[i]), 6),
            "fx": round(float(fx[i]), 6),
        })

pd.DataFrame(daily_rows).to_csv("daily.csv", index=False)

event_rows = []
for tk in tickers:
    for e in range(EVENTS_PER_TICKER):
        idx = FIRST_EVENT_AT + e * EVENT_STEP
        if idx + 25 >= N_SESSIONS:          # оставляем горизонт впереди
            break
        # доступность — утром сессии idx (до закрытия) → решение в закрытие idx
        avail = dates[idx].strftime("%Y-%m-%dT07:30:00Z")
        row = {
            "event_id": f"{tk}_{e}",
            "ticker": tk,
            "available_at": avail,
            "low_attention": round(float(rng.uniform(0, 1)), 3),
            # признаки отчётности — чистый шум (никакой связи с будущим)
            "f_revenue_yoy": round(float(rng.normal(0, 1)), 4),
            "f_margin_change": round(float(rng.normal(0, 1)), 4),
            "f_cfo_assets": round(float(rng.normal(0, 1)), 4),
            "f_leverage_change": round(float(rng.normal(0, 1)), 4),
        }
        # немного пропусков — проверить импутацию
        if rng.uniform() < 0.1:
            row["f_cfo_assets"] = ""
        event_rows.append(row)

pd.DataFrame(event_rows).to_csv("events.csv", index=False)

print(f"daily.csv: {len(daily_rows)} строк, events.csv: {len(event_rows)} событий")
print("Это ШУМ. Ожидаемо: r2_vs_zero≈0, spearman_ic≈0 у всех моделей.")
