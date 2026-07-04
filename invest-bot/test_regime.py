"""
test_regime.py — сторож поведения классификатора режима на СИНТЕТИКЕ.

Зачем: реального длительного роста в данных РФ-рынка нет (медведь 2-3 года),
поэтому «не душит ли правка настоящий тренд» на живых прогонах не проверить.
Здесь тренд/отскок/сквиз заданы ЧИСЛАМИ от руки — это инвариант, который
заменяет недостающие данные. Любая будущая правка regime.py, которая начнёт
метить настоящий рост как ranging (или пропускать сквиз как тренд), уронит
этот файл с FAIL — до заливки, а не через убыточный прогон.

Запуск:  python test_regime.py   → печатает OK или список FAIL и код возврата.
Без pytest (его в проекте нет) — голые assert'ы.
"""
import sys
from regime import classify_regime_probs, squeeze_adjust, oi_instability_adjust, OI_INSTABILITY_MAX_BOOST

_fails = []


def check(name, series, expected, daily=""):
    probs = classify_regime_probs(series)
    if daily:
        probs = squeeze_adjust(probs, daily)
    got = max(probs, key=probs.get)
    ok = got == expected
    tag = "OK " if ok else "FAIL"
    print(f"[{tag}] {name:34s} → {got:14s} (ждём {expected}{', daily='+daily if daily else ''})")
    if not ok:
        _fails.append(name)


# ── Классификатор на одном окне (regime.py) ──────────────────────────────────
N = 30
check("чистый рост", [100 + i * 0.8 for i in range(N)], "trending_up")
check("чистое падение", [100 - i * 0.8 for i in range(N)], "trending_down")
# отскок: структура вниз, последняя треть — резкий рост. НЕ тренд.
check("отскок в даунтренде",
      [100 - i * 0.9 for i in range(20)] + [82 + i * 1.6 for i in range(10)], "ranging")
# откат в аптренде (симметрия): НЕ trending_down.
check("откат в аптренде",
      [100 + i * 0.9 for i in range(20)] + [118 - i * 1.6 for i in range(10)], "ranging")
# сквиз: слабый наклон на сжатом диапазоне.
check("сквиз (сжатый ход)",
      [100 + i * 0.5 for i in range(20)] + [110 + 0.05 * i + (0.3 if i % 2 else -0.3)
                                            for i in range(10)], "ranging")

# ── Дневной контекст: ШОРТ-СКВИЗ (опыт пользователя) ─────────────────────────
# Чистый внутридневной рост САМ ПО СЕБЕ = trending_up (классификатор прав).
# Но если дневной режим — падение, этот «тренд» есть сжатая пружина (+24% за
# день-два, месяц всё равно -30%). Дневной контекст обязан увести его в ranging.
squeeze = [100 + i * 0.8 for i in range(N)]  # тот же «идеальный рост»
check("шорт-сквиз БЕЗ дневного контекста", squeeze, "trending_up")
check("шорт-сквиз в дневном даунтренде", squeeze, "ranging", daily="trending_down")
# здоровый тренд: внутридневной рост совпал с дневным → остаётся trending_up.
check("рост в дневном аптренде", squeeze, "trending_up", daily="trending_up")
# дневной STRESS: внутридневной тренд (любого знака) уводится в ranging —
# старший ТФ ломается, momentum-вход опасен.
check("рост при дневном стрессе", squeeze, "ranging", daily="stress")
check("падение при дневном стрессе",
      [100 - i * 0.8 for i in range(N)], "ranging", daily="stress")
# дневной high_vol НЕ блокирует внутридневной импульс (осознанно, см. squeeze_adjust).
check("рост при дневном high_vol", squeeze, "trending_up", daily="high_vol")

# ── OI-нестабильность → подмешивание в stress ────────────────────────────────
def _check_oi():
    base = classify_regime_probs([100 + i * 0.8 for i in range(N)])  # trending_up
    # instability=0 → без изменений
    if oi_instability_adjust(base, 0.0) != base:
        _fails.append("oi instability=0 меняет распределение"); print("[FAIL] oi instab=0")
    else:
        print("[OK ] oi instability=0 — no-op")
    # instability=1 → stress вырос ровно на max_boost, сумма сохранилась
    out = oi_instability_adjust(base, 1.0)
    d_stress = out["stress"] - base.get("stress", 0.0)
    ok = abs(d_stress - OI_INSTABILITY_MAX_BOOST) < 1e-9 and abs(sum(out.values()) - 1.0) < 1e-9
    print(f"[{'OK ' if ok else 'FAIL'}] oi instability=1 → +stress={d_stress:.3f} (ждём {OI_INSTABILITY_MAX_BOOST}), сумма={sum(out.values()):.3f}")
    if not ok:
        _fails.append("oi instability=1 неверно двигает stress/сумму")
    # монотонность: больше instability → больше stress
    s = [oi_instability_adjust(base, x)["stress"] for x in (0.0, 0.3, 0.6, 1.0)]
    mono = all(s[i] <= s[i+1] for i in range(len(s)-1))
    print(f"[{'OK ' if mono else 'FAIL'}] oi stress монотонен по instability: {[round(x,3) for x in s]}")
    if not mono:
        _fails.append("oi stress не монотонен")

_check_oi()


# ── OI-нестабильность из signal_gate (порт oi_lab): базовый уровень на шуме ──
# должен быть низким, а агрессивный односторонний набор шорта в хвосте — выше.
def _check_oi_instability():
    import random, statistics
    from signal_gate import oi_regime_instability
    def build(seed, tail_bias):
        random.seed(seed); rows=[]; fl=fs=100000; px=100.0
        for i in range(120):
            fl += random.randint(-300, 300); fs += random.randint(-300, 300)
            if i >= 112: fs += tail_bias
            px += random.uniform(-0.5, 0.5)
            rows.append({"tradedate": f"2025-{(i//28)+1:02d}-{(i%28)+1:02d}", "price": px,
                         "fiz_long": fl, "fiz_short": fs, "yur_long": 0, "yur_short": 0,
                         "contract": "SRU5"})
        return rows
    calm = statistics.median(oi_regime_instability(build(s, 0)) for s in range(30))
    tail = statistics.median(oi_regime_instability(build(s, 1500)) for s in range(30))
    thin = oi_regime_instability(build(0, 0)[:15])
    ok_base = calm <= 0.15           # шум не должен давать ложный высокий базовый уровень
    ok_sep = tail >= calm + 0.15     # squeeze-хвост заметно выше шума
    ok_thin = thin == 0.0            # мало истории → no-op
    print(f"[{'OK ' if ok_base else 'FAIL'}] OI instab базовый уровень на шуме: median={calm:.3f} (<=0.15)")
    print(f"[{'OK ' if ok_sep else 'FAIL'}] OI instab шорт-хвост выше шума: {tail:.3f} vs {calm:.3f}")
    print(f"[{'OK ' if ok_thin else 'FAIL'}] OI instab мало истории → 0: {thin}")
    for ok, nm in ((ok_base, "oi instab базовый уровень"), (ok_sep, "oi instab разделение"),
                   (ok_thin, "oi instab мало истории")):
        if not ok: _fails.append(nm)

_check_oi_instability()

if _fails:
    print(f"\n{len(_fails)} FAIL: {', '.join(_fails)}")
    sys.exit(1)
print("\nвсе инварианты режима держатся ✓")
