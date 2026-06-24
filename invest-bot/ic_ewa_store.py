"""
ic_ewa_store.py — общее хранилище IC и EWA-весов для multi-account торговли.

Структура: ic_store[method][tf][regime] → ICPrior
           ewa_store[method][tf][regime] → float (EWA-вес метода)

Каждый счёт читает/пишет свой срез по tf. Оба обогащают общее хранилище —
больше данных, быстрее обучение весов.

Потокобезопасность не гарантируется — предполагается однопоточное исполнение
(барная обработка в одном потоке, как в текущем invest-bot).
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field


@dataclass
class SharedICEWAStore:
    """
    Единое хранилище IC-prior объектов и EWA-весов для всех TF и режимов.

    Использование:
        store = SharedICEWAStore()
        ic_bucket = store.ic_bucket(tf=1)      # {regime: {method: ICPrior}}
        ewa_bucket = store.ewa_bucket(tf=60)   # {regime: {method: float}}

    Стратегия получает ic_bucket(tf) вместо своего внутреннего __ic_priors
    и работает с ним напрямую — все записи автоматически видны другим
    счетам с тем же TF.

    Потокобезопасность: bucket-создание защищено lock (asyncio.Tasks могут
    обращаться из разных корутин). Внутри bucket'а данные пишутся только
    стратегией на своём TF — пересечений нет, lock не нужен при доступе к
    содержимому.
    """
    _ic: dict = field(default_factory=dict)   # {tf: {regime: {method: ICPrior}}}
    _ewa: dict = field(default_factory=dict)  # {tf: {regime: {method: float}}}
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def ic_bucket(self, tf: int) -> dict:
        """Возвращает {regime: {method: ICPrior}} для данного TF.
        При первом обращении создаёт пустой bucket — стратегия заполняет его сама."""
        with self._lock:
            if tf not in self._ic:
                self._ic[tf] = {}
            return self._ic[tf]

    def ewa_bucket(self, tf: int) -> dict:
        """Возвращает {regime: {method: float}} для данного TF."""
        with self._lock:
            if tf not in self._ewa:
                self._ewa[tf] = {}
            return self._ewa[tf]

    def all_tfs(self) -> list[int]:
        return sorted(set(list(self._ic.keys()) + list(self._ewa.keys())))

    def snapshot(self) -> dict:
        """Сериализуемый снимок для сохранения/передачи (ICPrior → dict)."""
        result = {"ic": {}, "ewa": {}}
        for tf, regimes in self._ic.items():
            result["ic"][tf] = {}
            for regime, methods in regimes.items():
                result["ic"][tf][regime] = {
                    m: {"ic_smoothed": p.ic_smoothed, "n_updates": p.n_updates,
                        "invert": p.invert, "noise_mode": p.noise_mode,
                        "n_updates_effective": p.n_updates_effective}
                    for m, p in methods.items()
                }
        result["ewa"] = {str(tf): v for tf, v in self._ewa.items()}
        return result
