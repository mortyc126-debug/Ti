from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from sklearn.impute import SimpleImputer
from sklearn.linear_model import ElasticNet
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler


@dataclass(frozen=True)
class Config:
    horizon: int = 20
    factor_window: int = 252
    min_factor_obs: int = 120

    # Минимум уже завершившихся событий для обучения.
    min_train_events: int = 150

    # Фиксированные параметры первого эксперимента.
    # X и y стандартизируются исключительно на train.
    elastic_alpha: float = 0.03
    l1_ratio: float = 0.5

    factors: tuple = ("mkt", "sector", "fx")


MARKET_FEATURES = [
    "resid_mom_5",
    "resid_mom_20",
    "resid_vol_20",
    "market_mom_20",
    "release_session_resid",
]


def load_inputs(daily_path, events_path, cfg):
    daily = pd.read_csv(daily_path)
    events = pd.read_csv(events_path)

    required_daily = {
        "ticker", "close_time", "log_ret", *cfg.factors
    }
    required_events = {
        "event_id", "ticker", "available_at", "low_attention"
    }

    for name, frame, required in [
        ("daily", daily, required_daily),
        ("events", events, required_events),
    ]:
        missing = required - set(frame.columns)
        if missing:
            raise ValueError(f"{name}: нет колонок {sorted(missing)}")

    fcols = sorted(c for c in events if c.startswith("f_"))
    if not fcols:
        raise ValueError("Нужны фундаментальные признаки f_*")

    daily["close_time"] = pd.to_datetime(
        daily["close_time"], utc=True, errors="raise"
    )
    events["available_at"] = pd.to_datetime(
        events["available_at"], utc=True, errors="raise"
    )

    if daily["close_time"].isna().any():
        raise ValueError("Пустой close_time")
    if events["available_at"].isna().any():
        raise ValueError("Пустой available_at")

    if daily.duplicated(["ticker", "close_time"]).any():
        raise ValueError("Дубли ticker/close_time")
    if events["event_id"].duplicated().any():
        raise ValueError("Дубли event_id")

    for c in ["log_ret", *cfg.factors]:
        daily[c] = pd.to_numeric(daily[c], errors="raise")

    events["low_attention"] = pd.to_numeric(events["low_attention"], errors="raise")
    # Фундаментальные признаки могут отсутствовать (промежуточный отчёт без
    # финансов в снимке) — пустое → NaN, импутация разберётся на train.
    for c in fcols:
        events[c] = pd.to_numeric(events[c], errors="coerce")

    # NaN разрешены в фундаментальных данных:
    # импутация будет обучаться только на train.
    if np.isinf(events[fcols].to_numpy(dtype=float)).any():
        raise ValueError("Бесконечные фундаментальные значения")

    if not events["low_attention"].between(0, 1).all():
        raise ValueError(
            "low_attention должен быть известен и лежать в [0, 1]"
        )

    daily = daily.sort_values(["ticker", "close_time"])
    events = events.sort_values(["available_at", "event_id"])

    return daily, events, fcols


def build_event_dataset(daily, events, fcols, cfg):
    """
    Строит исторический набор завершившихся событий.

    Коэффициенты факторной модели:
        только сессии до decision_time.

    Признаки:
        доступны к decision_time.

    Цель:
        следующие horizon сессий, не включая decision_time.
    """
    panels = {
        ticker: group.reset_index(drop=True)
        for ticker, group in daily.groupby("ticker", sort=False)
    }

    rows = []
    skipped = {
        "no_ticker": 0,
        "insufficient_history_or_future": 0,
        "bad_market_data": 0,
    }
    missing_tickers = set()

    numeric_cols = ["log_ret", *cfg.factors]

    for _, event in events.iterrows():
        panel = panels.get(event["ticker"])

        if panel is None:
            skipped["no_ticker"] += 1
            missing_tickers.add(str(event["ticker"]))
            continue

        # Строго первое закрытие после доступности отчётности.
        t = int(
            panel["close_time"].searchsorted(
                event["available_at"], side="right"
            )
        )

        if (
            t < cfg.min_factor_obs
            or t + cfg.horizon >= len(panel)
        ):
            skipped["insufficient_history_or_future"] += 1
            continue

        history = panel.iloc[
            max(0, t - cfg.factor_window):t
        ]
        current = panel.iloc[t]
        future = panel.iloc[t + 1:t + 1 + cfg.horizon]

        # Не сжимаем время удалением дыр внутри окна:
        # такой event пропускаем целиком.
        block = pd.concat([
            history[numeric_cols],
            panel.iloc[t:t + 1][numeric_cols],
            future[numeric_cols],
        ])

        if not np.isfinite(
            block.to_numpy(dtype=float)
        ).all():
            skipped["bad_market_data"] += 1
            continue

        x_hist = history[list(cfg.factors)].to_numpy(float)
        x_hist = np.column_stack([
            np.ones(len(history)), x_hist
        ])
        y_hist = history["log_ret"].to_numpy(float)

        coef, *_ = np.linalg.lstsq(
            x_hist, y_hist, rcond=None
        )

        residual_history = y_hist - x_hist @ coef

        x_current = np.r_[
            1.0,
            current[list(cfg.factors)].to_numpy(dtype=float)
        ]
        release_session_resid = (
            float(current["log_ret"])
            - float(x_current @ coef)
        )

        x_future = future[list(cfg.factors)].to_numpy(float)
        x_future = np.column_stack([
            np.ones(len(future)), x_future
        ])

        future_residuals = (
            future["log_ret"].to_numpy(float)
            - x_future @ coef
        )

        row = {
            "event_id": event["event_id"],
            "ticker": event["ticker"],
            "available_at": event["available_at"],
            "decision_time": current["close_time"],
            "target_end": future.iloc[-1]["close_time"],

            "y": float(future_residuals.sum()),

            "resid_mom_5": float(residual_history[-5:].sum()),
            "resid_mom_20": float(residual_history[-20:].sum()),
            "resid_vol_20": float(
                residual_history[-20:].std(ddof=1)
            ),
            "market_mom_20": float(
                history[cfg.factors[0]].iloc[-20:].sum()
            ),
            "release_session_resid": release_session_resid,
            "low_attention": float(event["low_attention"]),
        }

        for col in fcols:
            value = event[col]
            row[col] = value
            row[f"{col}__x_low_attention"] = (
                value * row["low_attention"]
            )

        rows.append(row)

    if not rows:
        msg = f"Не удалось построить события. Причины: {skipped}"
        if skipped["no_ticker"]:
            have = sorted(panels.keys())
            miss = sorted(missing_tickers)
            msg += (
                f"\nТикеров в daily.csv: {len(have)} "
                f"(напр.: {', '.join(have[:12])}…)"
                f"\nНет в daily.csv у событий: {len(miss)} "
                f"(напр.: {', '.join(miss[:12])}…)"
                "\nПричина обычно: events.csv остался синтетический "
                "(make_smoke_data), либо тикеры событий не входят в "
                "универс make_daily_research (INVEST_TARGET). "
                "Сгенерируй events.csv из своего releases.csv "
                "(make_events_research.py) и убедись, что эти тикеры "
                "есть в daily.csv."
            )
        raise ValueError(msg)

    result = pd.DataFrame(rows).sort_values(
        ["decision_time", "event_id"]
    ).reset_index(drop=True)

    print("Событий:", len(result))
    print("Пропуски:", skipped)

    return result


def make_model(cfg):
    return Pipeline([
        (
            "imputer",
            SimpleImputer(
                strategy="median",
                add_indicator=True,
                keep_empty_features=True,
            ),
        ),
        ("scale", StandardScaler()),
        (
            "model",
            ElasticNet(
                alpha=cfg.elastic_alpha,
                l1_ratio=cfg.l1_ratio,
                max_iter=20000,
                selection="cyclic",
            ),
        ),
    ])


def walk_forward(dataset, fcols, cfg):
    """
    Expanding-window, переобучение раз в календарный месяц.

    В train попадают только события, у которых target_end
    строго раньше момента переобучения.

    Ни импутация, ни стандартизация не видят test.
    """
    interactions = [
        f"{c}__x_low_attention" for c in fcols
    ]

    feature_sets = {
        "market": MARKET_FEATURES,

        "market_attention": (
            MARKET_FEATURES + ["low_attention"]
        ),

        "fundamentals": (
            MARKET_FEATURES + fcols
        ),

        "additive": (
            MARKET_FEATURES + fcols + ["low_attention"]
        ),

        "interaction": (
            MARKET_FEATURES
            + fcols
            + ["low_attention"]
            + interactions
        ),
    }

    data = dataset.copy()
    data["test_month"] = (
        data["decision_time"].dt.strftime("%Y-%m")
    )

    predictions = []

    for _, test in data.groupby("test_month", sort=True):
        cutoff = test["decision_time"].min()

        train = data.loc[
            data["target_end"] < cutoff
        ].copy()

        if len(train) < cfg.min_train_events:
            continue

        y_train = train["y"].to_numpy(float)
        y_mean = float(y_train.mean())
        y_std = float(y_train.std(ddof=0))

        if y_std < 1e-10:
            continue

        y_scaled = (y_train - y_mean) / y_std

        out = test[[
            "event_id",
            "ticker",
            "decision_time",
            "target_end",
            "low_attention",
            "y",
        ]].copy()

        # Два простых ориентира без признаков.
        out["pred_zero"] = 0.0
        out["pred_train_mean"] = y_mean
        out["n_train"] = len(train)

        for name, columns in feature_sets.items():
            model = make_model(cfg)
            model.fit(train[columns], y_scaled)

            out[f"pred_{name}"] = (
                model.predict(test[columns]) * y_std + y_mean
            )

        predictions.append(out)

    if not predictions:
        raise ValueError(
            "Нет OOS-прогнозов: мало завершившихся событий. "
            "Нужна более длинная история/больше компаний."
        )

    return pd.concat(predictions, ignore_index=True)


def summarize(predictions):
    """
    Описательные OOS-метрики.
    Это НЕ проверка статистической значимости.
    """
    groups = {
        "all": predictions,
        "low_attention": predictions.loc[
            predictions["low_attention"] >= 0.7
        ],
        "high_attention": predictions.loc[
            predictions["low_attention"] <= 0.3
        ],
    }

    rows = []

    for group_name, frame in groups.items():
        if len(frame) < 20:
            continue

        y = frame["y"]
        zero_mse = float(np.mean(y.to_numpy() ** 2))

        for col in frame.columns:
            if not col.startswith("pred_"):
                continue

            p = frame[col]
            mse = float(np.mean((y - p) ** 2))

            ic = (
                float(y.corr(p, method="spearman"))
                if p.nunique() > 1 and y.nunique() > 1
                else np.nan
            )

            # Нулевой прогноз не трактуем как направление.
            mask = (p != 0) & (y != 0)
            sign_accuracy = (
                float(
                    (
                        np.sign(p.loc[mask])
                        == np.sign(y.loc[mask])
                    ).mean()
                )
                if mask.any()
                else np.nan
            )

            rows.append({
                "group": group_name,
                "model": col.removeprefix("pred_"),
                "n": len(frame),
                "mse": mse,
                "r2_vs_zero": (
                    1.0 - mse / zero_mse
                    if zero_mse > 0 else np.nan
                ),
                "spearman_ic": ic,
                "sign_accuracy": sign_accuracy,
            })

    return pd.DataFrame(rows)


def main():
    cfg = Config(horizon=20)

    daily, events, fcols = load_inputs(
        "daily.csv", "events.csv", cfg
    )

    dataset = build_event_dataset(
        daily, events, fcols, cfg
    )

    output = Path("earnings_drift_output")
    output.mkdir(exist_ok=True)
    # Сырой набор событий пишем СРАЗУ — он полезен сам по себе (остаточный
    # дрейф по каждому событию), даже если для walk-forward данных мало.
    dataset.to_csv(output / "events_dataset.csv", index=False)

    # Описательная сводка по дрейфу — работает при любом числе событий.
    y = dataset["y"]
    print("\n── Остаточный дрейф за", cfg.horizon, "сессий ──")
    print(f"событий: {len(dataset)} | средний y: {y.mean():+.4f} | "
          f"медиана: {y.median():+.4f} | доля y>0: {(y>0).mean():.0%}")
    lo = dataset.loc[dataset["low_attention"] >= 0.7, "y"]
    hi = dataset.loc[dataset["low_attention"] <= 0.3, "y"]
    if len(lo): print(f"низкое внимание (n={len(lo)}): средний y {lo.mean():+.4f}")
    if len(hi): print(f"высокое внимание (n={len(hi)}): средний y {hi.mean():+.4f}")
    print("\nпо событиям:")
    cols = [c for c in ("event_id","ticker","decision_time","y","low_attention") if c in dataset]
    print(dataset[cols].to_string(index=False))

    try:
        predictions = walk_forward(dataset, fcols, cfg)
    except ValueError as e:
        print(f"\n⚠ Walk-forward пропущен: {e}")
        print(f"Нужно ~{cfg.min_train_events}+ завершившихся событий для OOS "
              f"(сейчас {len(dataset)}). Введи даты раскрытия по большему числу "
              "эмитентов/лет и повтори. Сырой набор — в events_dataset.csv.")
        return

    metrics = summarize(predictions)
    predictions.to_csv(output / "oos_predictions.csv", index=False)
    metrics.to_csv(output / "metrics.csv", index=False)
    print("\n── OOS-метрики (base vs full) ──")
    print(metrics.to_string(index=False))


if __name__ == "__main__":
    main()
