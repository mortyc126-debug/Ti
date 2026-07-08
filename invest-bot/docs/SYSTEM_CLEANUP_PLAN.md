# Чистка системы за пределами методов композита

`METHOD_CLEANUP_PLAN.md` покрывает голоса-методы. Этот файл — про
остальные 7 зон, где живут баги, дубли и «неучтённые трудности».
Каждая зона: как проявляется, как найти, критерий «сломано», как чинить.


## Зона 1. Глотание ошибок → молчаливый 0.0 в скоре

**Симптом**: метод показывает n_fires=0 или всегда нейтральный на
конкретном тикере, хотя реально там сигналы должны быть. В логах — тихо.

**Что происходит**: `except Exception:` без re-raise и без `logger.exception`
проглатывает баг в реализации; метод возвращает 0.0 как «нейтральный», и
composite считает что метод пустой. Дальше — пойдёт по IC-калибровке как
«слабый», получит вес 0.5, но edge никогда не появится.

**Как найти:**
```bash
# голые pass'ы
grep -rnE "except.*:\s*pass\s*$" invest-bot --include="*.py"
# except без логгирования и без raise
grep -rnB1 -A3 "except Exception:" invest-bot --include="*.py" \
    | grep -v "logger\|logging\|raise"
```
Сейчас в репо: **373 `except Exception:`** без re-raise, **116 голых
`except: pass`**, **0 assert'ов** — инвариантов нигде не проверено.

**Критерий «баг»**: пойманное исключение без `logger.exception(...)` и без
осмысленного fallback (кроме `return 0.0`). Особенно опасно в `score_*`.

**Как чинить**:
1. Заменить `except Exception:` на конкретные `except (ValueError, KeyError, ...):`
2. Добавить `logger.warning("...", exc_info=True)` перед fallback.
3. Оставить голый `except Exception:` только на верхнем уровне main-loop.
4. За неделю все реальные сбои — в логах, с трейсбеками.


## Зона 2. Дашборд — второй god-объект (9676 строк)

**Симптом**: UI показывает одно, бот торгует другим. Или endpoint отвечает
не тот, кто нужен, и не понятно почему.

**Что происходит**: в 9K строк накопились устаревшие HTTP-маршруты,
дублирующие обработчики, скопированные из composite формулы, которые
разъехались с оригиналом.

**Как найти:**
```bash
# все определённые роуты
grep -oE '@.*route\("([^"]+)"' dashboard.py | sort -u > audit_dashboard_routes.txt
# каждый URL из списка — grep в HTML/JS файлах внутри репо
# если 0 совпадений → мёртвый роут
for url in $(cut -d'"' -f2 audit_dashboard_routes.txt); do
  cnt=$(grep -rc "$url" --include="*.html" --include="*.js" . || echo 0)
  echo "$cnt $url"
done | sort -n | head -20
```

**Критерий «мусор»**: 0 упоминаний URL в статике → роут никем не вызывается.

**Отдельно**: дубли вычислений. Найти функции в dashboard.py, чьи имена
похожи на `score_*` или `_compute_*` — те, что делают то же самое, что и
стратегия, но с расхождением.
```bash
grep -nE "def (score_|_compute_|calc_)" dashboard.py | head
```
Каждую сравнить с одноимённой из composite — если формула разъехалась,
UI и торговля не согласованы. Оставлять одну функцию, импортировать в
дашборд.


## Зона 3. Trader — цепь гейтов (3178 строк)

**Симптом**: в логах много `New signal has been skipped` с разными
причинами на одном тикере в короткий промежуток; в результате бот
пропускает сделки, которые визуально «должны были быть».

**Что происходит**: `signal_gate.evaluate` → `risk.can_open` →
`risk.position_size` → `__open_position_lots_count` → `__liquidity_lots_cap`.
Каждый может вернуть 0 при внутренней ошибке (глотается в except).
`available_lots = min(cash_lots, risk_qty, liquidity_lots)` — 0 от любого из
них блокирует вход.

**Как найти:**
```bash
# все места где min() накладывает лимит
grep -nE "min\(.*lots\|min\(.*qty" trading/trader.py
# в каждом — посмотреть где эти переменные считаются, есть ли except → 0
```

**Критерий «баг»**: hitcount конкретной причины скипа резко (в разы)
выше, чем другие. Если "liquidity 0" стреляет в 30% случаев, а
"risk_gate: против правила" — в 3% → liquidity_lots считается
некорректно.

**Как чинить**: логировать значения ВСЕХ трёх лимитов (`cash_lots`,
`risk_qty`, `liquidity_lots`) перед `min()` в один INFO-лог с ключами,
неделю собирать статистику, найти доминирующий 0-провайдер.


## Зона 4. Risk — грубая дискретизация confidence → risk_pct

**Симптом**: 80% сделок ложатся в один tier (RISK_MAX_PCT или
RISK_MID_PCT). Все реальные сделки имеют одинаковый размер, «сила
сигнала» не отражается в риске.

**Что происходит**: `confidence = 0.5 + 0.5 * |composite|` (стр. 9618
composite) → tier'ы дискретны. Composite=0.35 → conf=0.675, composite=0.75
→ conf=0.875 — обе в один и тот же tier. Порог перехода — случайное
пересечение конкретной константы, а не отражение «сильно/слабо».

**Как найти:**
```bash
# в trade_analytics — распределение confidence по сделкам
python -c "
import json
history = json.load(open('data/history.json'))
confs = [t['confidence'] for t in history if 'confidence' in t]
import statistics
print('mean', statistics.mean(confs), 'stdev', statistics.stdev(confs))
# гистограмма по tier'ам
for t in ('low','mid','high'):
    n = sum(1 for c in confs if _classify(c)==t)
    print(t, n)
"
```

**Критерий «баг»**: 60%+ сделок в одном tier, при этом WR у tier'ов не
отличается на >5%. Значит tier'ы не различают силу.

**Как чинить**: перейти на непрерывный `risk_pct = f(composite)` без
дискретных tier'ов, или калибровать пороги tier'ов так, чтобы делили
распределение confidence на равные квартили.


## Зона 5. Concurrency — non-atomic JSON writes

**Симптом**: `history.json` / `oi_daily.json` / `signal_gate.json` вдруг
битый → потеря статистики → EWA-веса тухнут в 0.5 нейтраль → WR
деградирует без изменений в коде.

**Что происходит**: `json.dump(..., open(path, 'w'))` — если процесс
убит между открытием и завершением записи, файл обрезан. Второй worker
читает битый JSON, ловит `JSONDecodeError`, инициализирует пустой словарь,
теряет всю историю.

**Как найти:**
```bash
grep -rnE "json\.dump\(.*open\(" invest-bot --include="*.py"
# и без tmp+replace
grep -rnB3 "json\.dump" invest-bot --include="*.py" \
    | grep -B3 "json.dump" | grep -v "\.tmp\|os\.replace"
```

Пример **правильно** (signal_gate.py:690-698):
```python
tmp = self._path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(self._calib.to_json(), f, ensure_ascii=False)
os.replace(tmp, self._path)  # атомарно
```

**Критерий «баг»**: любой `json.dump` без `.tmp` + `os.replace`.

**Как чинить**: обернуть в утилиту `atomic_write_json(path, data)` в
`archive.py` или `history.py`, заменить все прямые вызовы.


## Зона 6. State machines — застревающие состояния

**Симптом**: `__cached_phase` или `__last_regime` держится на одном
значении часами, хотя визуально режим сменился. Плейбуки не переключаются,
`REGIME_WEIGHT_MODS` даёт неверные веса.

**Что происходит**: три FSM в проекте — `narrative.py`
(`_narrative_state`), `classify_phase`, `__commit_regime_label`
(гистерезис режима). Гистерезис по построению «залипает» — при
некорректных настройках может не выпустить.

**Как найти:**
```bash
# найти все переменные состояния и их присвоения
grep -nE "self\._state\s*=|_narrative_state\s*=|state\s*=\s*['\"]" \
    invest-bot --include="*.py" | head -30
```
Дальше — построить граф переходов для каждой FSM (state × condition →
next_state), проверить: все ли комбинации покрыты, есть ли sink-states
(вошёл → не вышел).

**Критерий «баг»**: два состояния разного класса (например
`ranging` в `__last_regime` и `trending_up` в `argmax_regime`) держатся >
LAG_PENALTY_BARS × 3 подряд — гистерезис не переключает даже когда сырое
распределение уже сменилось.

**Как чинить**: логировать (state, argmax, regime_probs) при каждом
несовпадении committed vs argmax; если частота залипания >5% времени —
уменьшать глубину гистерезиса.


## Зона 7. scan vs live разъезжаются — САМЫЙ ОПАСНЫЙ

**Симптом**: результаты `redundancy_analysis`, `lag_analysis`,
`score_methods` не соответствуют тому, что видит `__compute_composite`
в live. Все калибровки — на выдуманных данных, реальный edge не
воспроизводится.

**Что происходит**: `scan_method_scores` (для оффлайн-анализа) и
`__compute_composite` (для live) считают методы независимыми путями.
Стоит одному пути применить лишний слой (например, alt_transforms,
regime_mods, IC.invert, redundancy_dampen) — и результаты разъезжаются.

**Как найти:**
```bash
# найти оба метода
grep -n "def scan_method_scores\|def __compute_composite" \
    trade_system/strategies/oi_composite_strategy.py

# точечная проверка — прогнать оба на одной свече, сравнить каждый скор
python -c "
from candle_archive import get_candles_cached
from trade_system.strategies.strategy_factory import StrategyFactory
from dashboard import _strategy_settings_by_ticker, _market_data, _db

settings = _strategy_settings_by_ticker()['SBER']
candles = get_candles_cached('SBER', settings.figi, 5, _market_data, _db)
strat = StrategyFactory.new_factory(settings.name, settings)

# путь live
strat._OICompositeStrategy__candles = candles
comp_live, scores_live = strat._OICompositeStrategy__compute_composite()

# путь scan
scan_rows = strat.scan_method_scores(candles)
scores_scan = scan_rows[-1]['scores']

# сравнить
for name in scores_scan:
    idx = ALL_METHOD_NAMES.index(name)
    live = scores_live[idx]
    scan = scores_scan[name]
    if abs(live - scan) > 1e-6:
        print(f'{name}: live={live:.4f} scan={scan:.4f}')
"
```

**Критерий «баг»**: любой метод показывает разницу > 1e-6 → пути
разъехались.

**Как чинить**: вынести общую логику в приватную функцию `_score_all(...)`,
вызывать её из обоих путей. Различие только в том, что live обновляет
буферы/состояние, а scan работает на копии.


## Ещё зоны (кратко)

**Таймзоны**. `datetime.now()` без `timezone.utc` = баги на границе
торгового дня (18:45 MSK → близко к суточному разделу). Проверить:
```bash
grep -rnE "datetime\.now\(\)|date\.today\(\)" invest-bot --include="*.py" \
    | grep -v "utc\|timezone\|tzinfo"
```

**Sandbox vs live**. `sandbox_monitor.py` пишет метрики sandbox, но
history.json и EWA-веса накапливаются одним пулом с live. `margin_per_lot`,
комиссии, задержки исполнения в sandbox отличаются. Проверить:
- ведётся ли отдельная статистика по каждому режиму (sandbox / live),
- переиспользуются ли EWA-веса из sandbox в live (это некорректно).

**.gitignore и терянные данные**. Кэш свечей и результаты score_methods
были в `.gitignore` — потеряны при пересоздании контейнера. Если
`data/analysis/` не исключён — коммитить туда.


## Единый статический аудит

```bash
mkdir -p invest-bot/data/analysis
cd invest-bot

# 1) глотание ошибок
grep -rnE "except.*:\s*pass\s*$" --include="*.py" . \
    > data/analysis/audit_silent_pass.txt
grep -rnE "except Exception:\s*$" --include="*.py" . \
    > data/analysis/audit_bare_except.txt

# 2) non-atomic writes
grep -rnE "json\.dump" --include="*.py" . \
    | grep -v "\.tmp\|os\.replace" \
    > data/analysis/audit_nonatomic_writes.txt

# 3) datetime.now без tz
grep -rnE "datetime\.now\(\)|date\.today\(\)" --include="*.py" . \
    | grep -v "utc\|timezone\|tzinfo" \
    > data/analysis/audit_naive_datetime.txt

# 4) dead функции
python3 << 'PY'
import ast, os
funcs = {}   # name -> file
calls = set()
for root, _, files in os.walk('.'):
    if '.git' in root or 'data/candle_cache' in root: continue
    for f in files:
        if not f.endswith('.py'): continue
        path = os.path.join(root, f)
        try: src = open(path, encoding='utf-8').read()
        except: continue
        try: tree = ast.parse(src)
        except SyntaxError: continue
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                funcs.setdefault(node.name, []).append(f"{path}:{node.lineno}")
            elif isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name): calls.add(node.func.id)
                elif isinstance(node.func, ast.Attribute): calls.add(node.func.attr)
dead = {n: locs for n, locs in funcs.items()
        if n not in calls and not n.startswith('_') and n not in ('main',)}
with open('data/analysis/audit_dead_funcs.txt', 'w') as f:
    for n, locs in sorted(dead.items()):
        f.write(f"{n}\n" + "\n".join(f"  {loc}" for loc in locs) + "\n")
PY

# 5) scan vs live расхождение
# (см. код выше в Зоне 7 — сделать отдельным скриптом)
```

Все 5 отчётов коммитим в `data/analysis/`. Чистка — из чата по этим
файлам, без запусков.


## Приоритет

| Зона | Урон если сломано | Приоритет |
|---|---|---|
| 7. scan vs live разъезжаются | Огромный (все калибровки лажают, скрытно) | **Максимум** |
| 1. Молчаливые except | Средний, но постоянный | **Высокий** |
| 5. Non-atomic JSON write | Катастрофический (редкий) | **Высокий** |
| 3. Trader gate-chain | Средний (пропуск сделок) | Средний |
| 4. Confidence discretization | Средний (неоптимальный размер) | Средний |
| 6. FSM sink-states | Средний (застревания) | Средний |
| 2. Dead endpoints в дашборде | Нулевой (чистка) | Низкий |

Шаг 1 — прогнать 5 отчётов, закоммитить в `data/analysis/`. Дальше
чистить и чинить по одному — в чате, по существу, без наблюдений
«неделю».
