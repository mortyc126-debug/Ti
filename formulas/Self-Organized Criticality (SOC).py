"""
Self-Organized Criticality (SOC) for Trading
=============================================

Implements the Bak-Tang-Wiesenfeld (BTW) sandpile model adapted for financial
time series, plus avalanche statistics, power-law fitting, and criticality
indicators useful in a trading context.

Key concepts:
  - The market is modelled as a sandpile on a 1-D lattice of "stress" cells.
  - Each cell accumulates return-shocks (grains). When a cell exceeds a
    threshold (z_c), it topples: it loses grains and redistributes them to
    neighbours — an *avalanche*.
  - Near criticality the avalanche-size distribution follows a power law:
      P(s) ~ s^{-tau}   with tau ≈ 1.5 (mean-field) or ~1.11 (1-D BTW)
  - The Hurst exponent and DFA scaling are used to confirm long-range
    dependence that is a signature of criticality.
  - A "criticality index" (0-1) aggregates these signals for trading use.

References:
  Bak, Tang, Wiesenfeld (1987). "Self-organized criticality".
  Plerou et al. (2002). "Self-organized criticality in stock-price fluctuations."
  Lux & Marchesi (1999). "Scaling and criticality in a stochastic multi-agent
      model of a financial market." Nature.
"""

from __future__ import annotations

import math
import statistics
import warnings
from dataclasses import dataclass, field
from typing import Sequence


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class Avalanche:
    """One toppling cascade triggered by a single grain addition."""
    start_index: int        # position in the price series that triggered it
    size: int               # total number of topplings across all cells & steps
    duration: int           # number of discrete toppling rounds until stable
    peak_stress: float      # maximum stress seen in any cell during the cascade
    cells_involved: list[int] = field(default_factory=list)  # which lattice cells toppled


@dataclass
class SOCResult:
    """Full output of run_soc()."""
    avalanches: list[Avalanche]

    # Power-law fit  P(s) ~ s^{-tau}
    tau: float                  # scaling exponent
    tau_stderr: float           # standard error of the OLS log-log fit
    tau_r2: float               # R² of the log-log fit
    xmin: float                 # lower cutoff used in the fit

    # Hurst / DFA
    hurst: float                # Hurst exponent via R/S analysis
    dfa_alpha: float            # DFA scaling exponent (alpha ≈ 0.5 → random,
                                #   > 0.5 → persistent, < 0.5 → anti-persistent)

    # Criticality
    criticality_index: float    # composite score in [0, 1]
    is_critical: bool           # True when the system is near SOC

    # Lattice state at the end of the simulation
    final_stress: list[float]

    # Raw avalanche sizes (convenient for external plotting / further analysis)
    avalanche_sizes: list[int]


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _returns(prices: Sequence[float]) -> list[float]:
    """Log-returns from a price series."""
    if len(prices) < 2:
        raise ValueError("Need at least 2 prices to compute returns.")
    return [math.log(prices[i] / prices[i - 1]) for i in range(1, len(prices))]


def _normalise(series: list[float]) -> list[float]:
    """Zero-mean, unit-variance normalisation."""
    mu = statistics.mean(series)
    sd = statistics.stdev(series) if len(series) > 1 else 1.0
    if sd == 0:
        sd = 1.0
    return [(x - mu) / sd for x in series]


def _linreg(x: list[float], y: list[float]) -> tuple[float, float, float, float]:
    """
    Ordinary least-squares linear regression y = a + b*x.
    Returns (intercept, slope, r2, slope_stderr).
    """
    n = len(x)
    if n < 2:
        return 0.0, 0.0, 0.0, 0.0
    mx, my = sum(x) / n, sum(y) / n
    sxx = sum((xi - mx) ** 2 for xi in x)
    sxy = sum((xi - mx) * (yi - my) for xi, yi in zip(x, y))
    syy = sum((yi - my) ** 2 for yi in y)
    if sxx == 0:
        return my, 0.0, 0.0, 0.0
    slope = sxy / sxx
    intercept = my - slope * mx
    ss_res = sum((yi - (intercept + slope * xi)) ** 2 for xi, yi in zip(x, y))
    r2 = 1.0 - ss_res / syy if syy > 0 else 0.0
    stderr = math.sqrt(ss_res / max(n - 2, 1) / sxx)
    return intercept, slope, r2, stderr


# ---------------------------------------------------------------------------
# Power-law fitting via log-log OLS (Hill estimator as first guess)
# ---------------------------------------------------------------------------

def _fit_power_law(
    sizes: list[int],
    xmin: float | None = None,
) -> tuple[float, float, float, float]:
    """
    Fit  P(s) ~ s^{-tau}  by linear regression on log-log CCDF.

    Parameters
    ----------
    sizes : list of avalanche sizes
    xmin  : lower cutoff; if None, uses the median size.

    Returns
    -------
    (tau, stderr, r2, xmin_used)
    """
    if not sizes:
        return 1.5, 0.0, 0.0, 1.0

    sorted_s = sorted(sizes)
    if xmin is None:
        xmin = sorted_s[len(sorted_s) // 2]

    filtered = [s for s in sorted_s if s >= xmin]
    if len(filtered) < 4:
        # Fall back to all data
        filtered = sorted_s

    n = len(filtered)
    # Complementary CDF  P(S >= s)
    log_s = [math.log(s) for s in filtered]
    log_p = [math.log((n - i) / n) for i in range(n)]

    _, slope, r2, stderr = _linreg(log_s, log_p)
    tau = -slope  # P(S>=s) ~ s^{-(tau-1)}, so the slope of log CCDF = -(tau-1)
    tau += 1      # convert to density exponent
    return max(tau, 0.5), abs(stderr), max(r2, 0.0), xmin


# ---------------------------------------------------------------------------
# Hurst exponent via classical R/S analysis
# ---------------------------------------------------------------------------

def _hurst_rs(series: list[float], min_window: int = 8) -> float:
    """
    Estimate the Hurst exponent H using rescaled range (R/S) analysis.

    H ≈ 0.5  → random walk / no memory
    H > 0.5  → persistent (trending)
    H < 0.5  → anti-persistent (mean-reverting)
    """
    n = len(series)
    if n < min_window * 2:
        return 0.5

    windows = []
    w = min_window
    while w <= n // 2:
        windows.append(w)
        w = int(w * 1.5) if int(w * 1.5) > w else w + max(1, w // 2)

    log_n, log_rs = [], []
    for w in windows:
        rs_vals = []
        for start in range(0, n - w + 1, w):
            chunk = series[start: start + w]
            mean_c = sum(chunk) / w
            deviations = [x - mean_c for x in chunk]
            cumdev = []
            running = 0.0
            for d in deviations:
                running += d
                cumdev.append(running)
            R = max(cumdev) - min(cumdev)
            S = statistics.stdev(chunk) if len(chunk) > 1 else 1e-10
            if S > 0:
                rs_vals.append(R / S)
        if rs_vals:
            log_n.append(math.log(w))
            log_rs.append(math.log(sum(rs_vals) / len(rs_vals)))

    if len(log_n) < 2:
        return 0.5

    _, slope, _, _ = _linreg(log_n, log_rs)
    return max(0.0, min(1.0, slope))


# ---------------------------------------------------------------------------
# Detrended Fluctuation Analysis (DFA)
# ---------------------------------------------------------------------------

def _dfa(series: list[float], min_window: int = 8) -> float:
    """
    DFA scaling exponent alpha.

    alpha ~ 0.5  → uncorrelated noise
    alpha ~ 1.0  → 1/f (pink) noise — hallmark of criticality
    alpha > 1    → non-stationary / strong trends
    """
    n = len(series)
    if n < min_window * 2:
        return 0.5

    # Integrated series (profile)
    mean_s = sum(series) / n
    profile = []
    running = 0.0
    for x in series:
        running += x - mean_s
        profile.append(running)

    windows = []
    w = min_window
    while w <= n // 4:
        windows.append(w)
        w = int(w * 1.5) if int(w * 1.5) > w else w + max(1, w // 2)

    log_n, log_f = [], []
    for w in windows:
        fluctuations = []
        for start in range(0, n - w + 1, w):
            seg = profile[start: start + w]
            xs = list(range(w))
            _, slope, _, _ = _linreg(xs, seg)
            intercept_v = sum(seg) / w - slope * (w - 1) / 2
            trend = [intercept_v + slope * i for i in range(w)]
            rms = math.sqrt(sum((s - t) ** 2 for s, t in zip(seg, trend)) / w)
            fluctuations.append(rms)
        if fluctuations:
            f_avg = sum(fluctuations) / len(fluctuations)
            if f_avg > 0:
                log_n.append(math.log(w))
                log_f.append(math.log(f_avg))

    if len(log_n) < 2:
        return 0.5

    _, slope, _, _ = _linreg(log_n, log_f)
    return max(0.0, min(2.0, slope))


# ---------------------------------------------------------------------------
# 1-D BTW sandpile adapted for financial returns
# ---------------------------------------------------------------------------

def _run_sandpile(
    shocks: list[float],
    n_cells: int,
    z_c: float,
    dissipation: float,
) -> list[Avalanche]:
    """
    Run the 1-D BTW sandpile model on a sequence of stress shocks.

    Parameters
    ----------
    shocks      : normalised return shocks (one per time step).
    n_cells     : number of lattice cells.
    z_c         : toppling threshold (critical slope).
    dissipation : fraction of grains lost at boundaries [0, 1).

    Returns
    -------
    List of Avalanche objects, one per toppling cascade triggered.
    """
    stress = [0.0] * n_cells
    avalanches: list[Avalanche] = []

    for t, shock in enumerate(shocks):
        # Add grain to a cell proportional to the shock magnitude,
        # spread across the lattice with a Gaussian kernel centred at the middle.
        centre = n_cells // 2
        for c in range(n_cells):
            dist = abs(c - centre)
            weight = math.exp(-0.5 * (dist / max(n_cells / 4, 1)) ** 2)
            stress[c] += abs(shock) * weight

        # Directional bias: negative shocks push stress toward the left boundary,
        # positive toward the right — a crude proxy for bull/bear pressure.
        if shock < 0:
            stress[0] += abs(shock) * 0.3
        else:
            stress[-1] += abs(shock) * 0.3

        # Relaxation (toppling) loop
        toppling_count = 0
        duration = 0
        cells_toppled: set[int] = set()
        peak_stress = max(stress)

        changed = True
        while changed:
            changed = False
            duration += 1
            for c in range(n_cells):
                if stress[c] >= z_c:
                    changed = True
                    toppling_count += 1
                    cells_toppled.add(c)
                    delta = stress[c] - z_c * 0.5  # amount redistributed

                    # Boundary dissipation
                    if c == 0:
                        stress[c] -= delta
                        stress[c + 1] += delta * (1 - dissipation) / 2
                    elif c == n_cells - 1:
                        stress[c] -= delta
                        stress[c - 1] += delta * (1 - dissipation) / 2
                    else:
                        stress[c] -= delta
                        half = delta * (1 - dissipation) / 2
                        stress[c - 1] += half
                        stress[c + 1] += half

                    peak_stress = max(peak_stress, max(stress))

            # Safety cap: prevent infinite loops on extreme input
            if duration > n_cells * 10:
                warnings.warn(
                    f"Toppling at t={t} did not converge after {duration} rounds; "
                    "consider increasing z_c or dissipation.",
                    RuntimeWarning,
                    stacklevel=4,
                )
                break

        if toppling_count > 0:
            avalanches.append(Avalanche(
                start_index=t,
                size=toppling_count,
                duration=duration,
                peak_stress=peak_stress,
                cells_involved=sorted(cells_toppled),
            ))

    return avalanches


# ---------------------------------------------------------------------------
# Criticality index
# ---------------------------------------------------------------------------

def _criticality_index(
    tau: float,
    tau_r2: float,
    hurst: float,
    dfa_alpha: float,
    n_avalanches: int,
    n_steps: int,
) -> float:
    """
    Composite criticality score in [0, 1].

    Component weights (sum = 1):
      0.35  power-law quality  (tau near 1.5 with high R²)
      0.25  Hurst persistence  (H > 0.5)
      0.25  DFA near 1/f       (alpha near 1.0)
      0.15  avalanche density  (frequent cascades)
    """
    # Power-law score: peak at tau=1.5, tolerance ±0.5, weighted by R²
    tau_ideal = 1.5
    tau_score = max(0.0, 1.0 - abs(tau - tau_ideal) / 0.8) * max(0.0, tau_r2)

    # Hurst score: ramp from 0.5 (score=0) to 1.0 (score=1)
    hurst_score = max(0.0, min(1.0, (hurst - 0.5) / 0.5))

    # DFA score: peak at alpha=1.0, tolerance ±0.4
    dfa_score = max(0.0, 1.0 - abs(dfa_alpha - 1.0) / 0.6)

    # Avalanche density score
    density = n_avalanches / max(n_steps, 1)
    # Expect density in [0.05, 0.40] for a critical system
    if density < 0.05:
        density_score = density / 0.05
    elif density <= 0.40:
        density_score = 1.0
    else:
        density_score = max(0.0, 1.0 - (density - 0.40) / 0.60)

    index = (0.35 * tau_score
             + 0.25 * hurst_score
             + 0.25 * dfa_score
             + 0.15 * density_score)
    return round(max(0.0, min(1.0, index)), 4)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def run_soc(
    prices: Sequence[float],
    *,
    n_cells: int = 20,
    z_c: float = 2.5,
    dissipation: float = 0.10,
    xmin: float | None = None,
    criticality_threshold: float = 0.55,
) -> SOCResult:
    """
    Run Self-Organized Criticality analysis on a financial price series.

    Parameters
    ----------
    prices : Sequence[float]
        Closing prices (or any positive time series). Minimum length: 30.

    n_cells : int, default 20
        Number of lattice cells in the 1-D sandpile. Larger values give finer
        spatial resolution but increase computation time quadratically in the
        worst case.  Typical range: 10–50.

    z_c : float, default 2.5
        Critical threshold (stress per cell) that triggers a toppling.
        Lower values → more frequent, smaller avalanches.
        Higher values → rarer, larger avalanches.
        Tune so that avalanche density is roughly 10–35 % of time steps.

    dissipation : float, default 0.10
        Fraction of stress energy dissipated at the boundaries during each
        toppling step.  0 = conservative (no energy loss), 1 = fully
        dissipative.  Near-critical systems require dissipation > 0.

    xmin : float | None, default None
        Lower size cutoff for power-law fitting. If None, set automatically
        to the median avalanche size. Explicitly pass a value to override
        (e.g. xmin=5 to ignore micro-avalanches).

    criticality_threshold : float, default 0.55
        Minimum criticality_index to classify the system as ``is_critical``.

    Returns
    -------
    SOCResult
        See the SOCResult dataclass for a full description of all fields.

    Raises
    ------
    ValueError
        If the price series has fewer than 30 elements or contains non-positive
        values (which would make log-returns undefined).

    Examples
    --------
    >>> prices = [100 + i * 0.1 + (i % 7) * 0.5 for i in range(200)]
    >>> result = run_soc(prices)
    >>> print(f"tau={result.tau:.3f}  H={result.hurst:.3f}  CI={result.criticality_index:.3f}")
    """
    # --- validation ---
    prices = list(prices)
    if len(prices) < 30:
        raise ValueError(f"Price series too short ({len(prices)}); need at least 30 points.")
    if any(p <= 0 for p in prices):
        raise ValueError("All prices must be strictly positive (log-returns require p > 0).")

    # --- returns & normalisation ---
    rets = _returns(prices)
    norm_shocks = _normalise(rets)

    # --- sandpile simulation ---
    avalanches = _run_sandpile(norm_shocks, n_cells=n_cells, z_c=z_c, dissipation=dissipation)

    # --- power-law fit ---
    sizes = [av.size for av in avalanches]
    if sizes:
        tau, tau_se, tau_r2, xmin_used = _fit_power_law(sizes, xmin=xmin)
    else:
        tau, tau_se, tau_r2, xmin_used = 1.5, 0.0, 0.0, 1.0

    # --- Hurst & DFA on the return series ---
    hurst = _hurst_rs(rets)
    dfa_alpha = _dfa(rets)

    # --- criticality index ---
    ci = _criticality_index(
        tau=tau,
        tau_r2=tau_r2,
        hurst=hurst,
        dfa_alpha=dfa_alpha,
        n_avalanches=len(avalanches),
        n_steps=len(norm_shocks),
    )

    # reconstruct final lattice stress (re-run is expensive; we track it inside
    # the sandpile but don't expose intermediate states — return the final state)
    # We reuse the last stress computed inside _run_sandpile via a thin wrapper.
    final_stress = _run_sandpile_final_state(norm_shocks, n_cells, z_c, dissipation)

    return SOCResult(
        avalanches=avalanches,
        tau=tau,
        tau_stderr=tau_se,
        tau_r2=tau_r2,
        xmin=xmin_used,
        hurst=hurst,
        dfa_alpha=dfa_alpha,
        criticality_index=ci,
        is_critical=ci >= criticality_threshold,
        final_stress=final_stress,
        avalanche_sizes=sizes,
    )


def _run_sandpile_final_state(
    shocks: list[float],
    n_cells: int,
    z_c: float,
    dissipation: float,
) -> list[float]:
    """Return only the final stress vector (avoids storing it in the main loop)."""
    stress = [0.0] * n_cells
    centre = n_cells // 2
    for shock in shocks:
        for c in range(n_cells):
            dist = abs(c - centre)
            weight = math.exp(-0.5 * (dist / max(n_cells / 4, 1)) ** 2)
            stress[c] += abs(shock) * weight
        if shock < 0:
            stress[0] += abs(shock) * 0.3
        else:
            stress[-1] += abs(shock) * 0.3
        changed = True
        iters = 0
        while changed and iters < n_cells * 10:
            changed = False
            iters += 1
            for c in range(n_cells):
                if stress[c] >= z_c:
                    changed = True
                    delta = stress[c] - z_c * 0.5
                    if c == 0:
                        stress[c] -= delta
                        stress[c + 1] += delta * (1 - dissipation) / 2
                    elif c == n_cells - 1:
                        stress[c] -= delta
                        stress[c - 1] += delta * (1 - dissipation) / 2
                    else:
                        stress[c] -= delta
                        half = delta * (1 - dissipation) / 2
                        stress[c - 1] += half
                        stress[c + 1] += half
    return [round(s, 6) for s in stress]


# ---------------------------------------------------------------------------
# Convenience: rolling criticality index
# ---------------------------------------------------------------------------

def rolling_criticality(
    prices: Sequence[float],
    window: int = 100,
    step: int = 10,
    **soc_kwargs,
) -> list[dict]:
    """
    Compute the criticality index over a rolling window.

    Useful for detecting *transitions* into or out of a critical regime —
    the onset of criticality often precedes large market moves.

    Parameters
    ----------
    prices  : full price series.
    window  : number of price bars per SOC window.  Min 30.
    step    : bars to advance between windows.
    **soc_kwargs : forwarded to run_soc() (n_cells, z_c, dissipation, …).

    Returns
    -------
    List of dicts with keys:
        start, end, criticality_index, is_critical, tau, hurst, dfa_alpha,
        n_avalanches.
    """
    prices = list(prices)
    if window < 30:
        raise ValueError("window must be >= 30.")

    results = []
    for start in range(0, len(prices) - window + 1, step):
        chunk = prices[start: start + window]
        try:
            r = run_soc(chunk, **soc_kwargs)
            results.append({
                "start": start,
                "end": start + window - 1,
                "criticality_index": r.criticality_index,
                "is_critical": r.is_critical,
                "tau": round(r.tau, 4),
                "hurst": round(r.hurst, 4),
                "dfa_alpha": round(r.dfa_alpha, 4),
                "n_avalanches": len(r.avalanches),
            })
        except (ValueError, RuntimeWarning):
            continue

    return results


# ---------------------------------------------------------------------------
# Avalanche statistics helpers
# ---------------------------------------------------------------------------

def avalanche_statistics(avalanches: list[Avalanche]) -> dict:
    """
    Compute descriptive statistics over a list of avalanches.

    Returns a dict with: count, mean_size, median_size, max_size, std_size,
    mean_duration, max_duration, mean_peak_stress, size_cv (coefficient of
    variation — high CV is consistent with power-law / heavy-tailed behaviour).
    """
    if not avalanches:
        return {k: 0 for k in (
            "count", "mean_size", "median_size", "max_size", "std_size",
            "mean_duration", "max_duration", "mean_peak_stress", "size_cv"
        )}

    sizes = [a.size for a in avalanches]
    durations = [a.duration for a in avalanches]
    peaks = [a.peak_stress for a in avalanches]

    mean_s = statistics.mean(sizes)
    std_s = statistics.stdev(sizes) if len(sizes) > 1 else 0.0

    return {
        "count": len(avalanches),
        "mean_size": round(mean_s, 3),
        "median_size": statistics.median(sizes),
        "max_size": max(sizes),
        "std_size": round(std_s, 3),
        "mean_duration": round(statistics.mean(durations), 3),
        "max_duration": max(durations),
        "mean_peak_stress": round(statistics.mean(peaks), 4),
        "size_cv": round(std_s / mean_s, 4) if mean_s > 0 else 0.0,
    }


# ---------------------------------------------------------------------------
# Quick self-test / demo (run as script)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import random
    random.seed(42)

    # Synthetic price series with a few trend breaks
    def _synthetic_prices(n: int = 300) -> list[float]:
        price = 100.0
        prices = [price]
        segments = [(60, 0.05, 0.8), (80, -0.08, 1.2),
                    (70, 0.02, 0.6), (90, 0.12, 1.5)]
        for length, drift, vol in segments:
            for _ in range(min(length, n - len(prices))):
                price *= math.exp(drift / 252 + vol / math.sqrt(252) * random.gauss(0, 1))
                prices.append(price)
                if len(prices) >= n:
                    break
        return prices[:n]

    px = _synthetic_prices(300)

    print("=" * 60)
    print("  Self-Organized Criticality — demo run")
    print("=" * 60)

    result = run_soc(px, n_cells=15, z_c=2.0, dissipation=0.12)

    print(f"\n  Price bars          : {len(px)}")
    print(f"  Avalanches found    : {len(result.avalanches)}")
    print(f"  Power-law exponent  : tau = {result.tau:.4f}  (ideal ≈ 1.5)")
    print(f"  Power-law R²        : {result.tau_r2:.4f}")
    print(f"  Hurst exponent      : H   = {result.hurst:.4f}  (>0.5 = trending)")
    print(f"  DFA alpha           : α   = {result.dfa_alpha:.4f}  (1.0 = 1/f noise)")
    print(f"  Criticality index   : CI  = {result.criticality_index:.4f}")
    print(f"  Is critical?        : {result.is_critical}")

    stats = avalanche_statistics(result.avalanches)
    print("\n  Avalanche statistics:")
    for k, v in stats.items():
        print(f"    {k:<22}: {v}")

    print("\n  Rolling criticality (window=100, step=20):")
    rolling = rolling_criticality(px, window=100, step=20, n_cells=15, z_c=2.0, dissipation=0.12)
    for row in rolling:
        flag = "*** CRITICAL ***" if row["is_critical"] else ""
        print(f"    bars {row['start']:>3}–{row['end']:>3}  "
              f"CI={row['criticality_index']:.3f}  "
              f"tau={row['tau']:.3f}  H={row['hurst']:.3f}  {flag}")

    print("\n  Final lattice stress (first 5 cells):")
    print("   ", result.final_stress[:5])
    print("=" * 60)
