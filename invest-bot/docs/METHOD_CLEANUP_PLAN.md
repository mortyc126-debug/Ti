# Чистка методов композита — план проверки и удаления

> **СТАТУС (обновляется по мере работы, видно через main):**
> - ✅ `score_methods.py --by-regime` написан и прогнан (stride 5 и 20).
>   Для финала нужен **stride 1** (Шаг 1.1) — ещё не гонялся.
> - ✅ `data/method_presets.json` создан из того прогона (2 пресета:
>   pool_2026-07 и minimal_risk).
> - ✅ `data/method_toggle_state.json` сброшен в пустой — авто-пресет
>   не навязывается (как и ожидает Шаг 0).
> - ✅ `redundancy_analysis.py` и `lag_analysis.py` теперь **импортируются
>   без tinkoff SDK** (Python 3.14): в начало обоих добавлен bootstrap
>   локального stub, дополнены `_tinkoff_stub` (constants.py, grpc.py,
>   utils.now). `--help` у обоих работает. Прогон — на машине с кэшем
>   свечей (здесь кэша нет, поэтому докачка падает — это норма).
> - ✅ `data/analysis/` заведена (+ README, + исключение в `.gitignore`).
>   Готова принять три файла Шага 1.
> - ⏳ Сами 3 прогона Шага 1 (stride 1) — на машине с кэшем, выхлопа ещё нет.
> - ⏳ Шаги 2-5 — впереди.
>
> Отдельно ведётся `NW_MEMORY_FINDINGS.md` — journal по НОВОМУ методу
> (NW-память T/P/color). Это не про чистку, а про добавление; не
> конфликтует с этим планом.

Цель: убрать из `OICompositeStrategy` всё, что не даёт edge, дублирует уже
работающее, или запаздывает так, что бесполезно для торговли на 1-5м.

Работаем на кэше свечей (`data/candle_cache/`, есть локально). Tinkoff API
не нужен нигде, кроме `redundancy_analysis.py` (там — только для валидации
на реальных сделках через `backtest_barriers`).

Все проверки — обратимые: сначала пометки в `method_toggle_state.json`,
удаление кода — последним шагом, когда результат подтверждён.


## Шаг 0 — что уже есть, чего не хватает

**Есть:**
- `data/method_presets.json` — итог одного прогона `score_methods.py --by-regime`
  на пуле ~418 тикеров (июль 2026). Классифицирует методы как universal noise
  или universal anti. Сырые числа (d по режимам, n_fires) в CSV **не сохранены**.
- `data/method_toggle_state.json` — сейчас пуст (`disabled=[]`, `inverted=[]`),
  ни один пресет не применён.

**Не хватает:**
- CSV с сырыми `d`, `n_fires`, `n_wins` по каждой паре (метод × режим). Без них
  видны только «universal» вердикты, теряется серая зона (методы, работающие
  в 2-3 режимах из 6).
- RMT-очищенных корреляций внутри кластеров (`redundancy_analysis.py` ни разу
  не запускался — выхлопа в репо нет).
- Лаг-профилей (`lag_analysis.py` — то же).
- `data/history.json` — сделки бота. Без него `avg_quality` в
  `redundancy_analysis` останется пуст, кандидаты «мёртвый груз» не пометятся.


## Шаг 1 — 3 прогона, ~1 вечер на локальной машине

```bash
# 1) полный по-режимный отчёт с сырыми числами
python score_methods.py ALL --workers 8 --stride 1 --by-regime \
    --out data/analysis/scores_by_regime.csv

# 2) RMT-corr внутри кластеров + avg_quality на исторических сделках
python redundancy_analysis.py --all --days 60 \
    > data/analysis/redundancy_report.txt

# 3) лаг метода → forward return
python lag_analysis.py --all --days 60 --horizon 3 \
    > data/analysis/lag_report.txt
```

Коммитим все три файла в `data/analysis/` (добавить исключение из
`.gitignore` для этой папки). Дальше вся чистка — в чате по этим файлам,
без повторных запусков.


## Шаг 2 — критерии отсечения по каждой проверке

Каждая ловит своё, ни одну заменить нельзя.

| Проверка | Что ловит | Уличает то, что другие пропускают | Критерий «убить» |
|---|---|---|---|
| **score_methods --by-regime** | Есть ли направленный edge и с каким знаком | Единственный видит anti-методы (метод даёт edge, но с обратным знаком — corr-анализ этого не покажет) | \|d\| ≤ 0.05 во **всех 6 режимах** при n_fires > 1000 → шум; d ≤ -0.05 стабильно → anti |
| **redundancy_analysis** | Дубли внутри кластера | Оба метода могут показывать хороший edge независимо, но говорить об одном событии | avg_abs_corr ≥ 0.7 с другим методом кластера И avg_quality ~ 0.5 → мёртвый груз |
| **lag_analysis** | Запаздывающие методы | Метод корректно предсказывает **прошлое**: corr к fwd_ret на lag=15 = movement уже случилось | median_lag > horizon (>3-5 баров) → на 1м/5м бесполезен |

Не заменяют друг друга: PRICE_TREND по score_methods пометится как anti;
RSI_DIVERGENCE и WANING_IMPULSES оба покажут положительный d, но redundancy
уличит их corr=0.71; CYBER_CYCLE может проходить оба — а lag покажет, что
пик кросс-корреляции в 15 барах, для 1м мусор.


## Шаг 3 — обработка результатов, ничего пока не удаляем

Собираем таблицу вида:

| метод | n_fires | median d (6 режимов) | max \|d\| в режимах | median corr в кластере | median lag | вердикт |
|---|---|---|---|---|---|---|
| PRICE_TREND | 45000 | -0.08 | 0.11 (stress) | 0.63 | 2 | инвертировать |
| RSI_DIVERGENCE | 12000 | +0.04 | 0.07 | 0.71 (с WANING) | 4 | удалить, WANING покрывает |
| FRACTAL | — | — | — | — | — | удалить, всегда 0.0 |
| ... | | | | | | |

Правила:
1. `n_fires < 50` (за 60 дней × 400 тикеров при stride=1) → метод молчит, удалить.
2. `median d ≤ -0.05 & max |d| < 0.10` → универсально anti, инвертировать через toggle_state.
3. `|d| ≤ 0.05` во всех 6 режимах при n_fires > 1000 → шум, disable.
4. `corr ≥ 0.7` с другим методом кластера И меньший quality → удалить.
5. `d > 0.05 только в 1-2 режимах` → оставить, но в `REGIME_WEIGHT_MODS`
   обнулить в остальных.
6. `median lag > 5` → удалить (запаздывающий метод не даёт edge на короткой TF).


## Шаг 4 — применение через toggle_state (обратимое)

```json
// data/method_toggle_state.json
{
  "disabled": [ ...из таблицы... ],
  "inverted": [ ...из таблицы... ]
}
```

Прогон бота 3-5 сессий. Метрики (WR, expectancy) сравниваем с baseline
до применения. Если хуже — откат одним изменением JSON.


## Шаг 5 — удаление кода (необратимое, только после Шага 4)

Из `oi_composite_strategy.py`:
- строки из `METHODS`,
- ключи из `METHOD_TF_CONFIG`,
- ссылки в `STRATEGY_CLUSTERS` (`cluster_models.py`),
- удаление функций `score_*` целиком,
- вычистить упоминания в `REGIME_WEIGHT_MODS`, `_ALT_*`, `_STRONG_SIGNAL_VETO_METHODS`,
- удалить из `data/method_toggle_state.json` (уже не нужно).

Проверка синтаксиса (`python -c "import trade_system.strategies.oi_composite_strategy"`).
Прогон backtest_barriers на 5-10 тикерах: WR должен совпасть с последней
сессией Шага 4.


## Отдельно — проверка слоёв (плейбуки, веты, множители)

`score_methods` не проверяет слои — только скоры отдельных методов. Слои
(`_compute_playbooks`, `LEVEL_VETO`, `MMI_VETO`, `HURST_VETO`,
`STRONG_SIGNAL_VETO`, `alt_transforms`, `mtf5-blend`, `redundancy_mult`,
`microstructure_boost`, `divergence`, `atr_exhaustion`, `phase_mods`)
нужно тестировать A/B через env-флаг:

```python
# в верху oi_composite_strategy.py
_DISABLED_LAYERS = set(os.getenv("COMPOSITE_DISABLED_LAYERS", "").split(","))

# каждый слой в __compute_composite обернуть:
if "playbooks" not in _DISABLED_LAYERS:
    playbook_score, ... = _compute_playbooks(...)
else:
    playbook_score, active_playbooks = 0.0, []
# и так далее
```

Прогон:
```bash
for layer in playbooks mtf5 level_veto mmi_veto hurst_veto strong_veto \
             divergence alt_transform phase_mods redundancy \
             microstructure_boost atr_exhaustion; do
  COMPOSITE_DISABLED_LAYERS=$layer python run_pipeline.py \
      --backtest --tickers ALL --days 60 --out data/analysis/ab_$layer.csv
done
```

Слой, выключение которого не меняет WR ±1% — балласт, удаляем. Отсечка
≥3-5% — слой реально полезен.

**Плейбуки** — есть встроенная per-regime статистика в `__playbook_disabled`
(см. `_compute_composite`, ~строка 8708). Смотрим в дашборде: плейбук,
попавший в disabled в ≥5 из 6 режимов, удаляем целиком из `_compute_playbooks`.


## Приоритет

1. Прогнать три скрипта Шага 1 — 1 вечер, никаких изменений в код.
2. По результатам заполнить `method_toggle_state.json` — 5 минут в чате.
3. Прогон 3-5 сессий бота — сравнение метрик с baseline.
4. Только если WR ≥ baseline — удаление кода.
5. Отдельно — env-флаг слоёв, A/B прогон, чистка балласта.

Всё до Шага 5 обратимо.
