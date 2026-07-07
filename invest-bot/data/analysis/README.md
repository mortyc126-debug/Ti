# data/analysis — выхлоп Шага 1 чистки методов

Сюда кладутся три файла из `METHOD_CLEANUP_PLAN.md` (Шаг 1), которые
генерируются на машине с кэшем свечей (`data/candle_cache/`). Папка
версионируется (исключение в `.gitignore`), чтобы чистку можно было вести
по файлам в чате, без повторных прогонов.

```bash
python score_methods.py ALL --workers 8 --stride 1 --by-regime \
    --out data/analysis/scores_by_regime.csv
python redundancy_analysis.py --all --days 60 > data/analysis/redundancy_report.txt
python lag_analysis.py --all --days 60 --horizon 3 > data/analysis/lag_report.txt
```

Ожидаемые файлы:
- `scores_by_regime.csv` — d, n_fires, n_wins по каждой паре (метод × режим).
- `redundancy_report.txt` — RMT-corr внутри кластеров + avg_quality.
- `lag_report.txt` — лаг-профиль метода → forward return.
