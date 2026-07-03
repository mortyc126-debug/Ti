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
from regime import classify_regime_probs, squeeze_adjust

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

if _fails:
    print(f"\n{len(_fails)} FAIL: {', '.join(_fails)}")
    sys.exit(1)
print("\nвсе инварианты режима держатся ✓")
