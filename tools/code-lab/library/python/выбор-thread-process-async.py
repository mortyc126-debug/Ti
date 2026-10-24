def recommend_workload(kind: str) -> str:
    mapping = {
        "async-io": "asyncio",
        "blocking-io": "ThreadPoolExecutor",
        "cpu-bound": "ProcessPoolExecutor",
    }
    try:
        return mapping[kind]
    except KeyError as exc:
        raise ValueError(f"Неизвестный тип нагрузки: {kind}") from exc

assert recommend_workload("async-io") == "asyncio"
assert recommend_workload("cpu-bound") == "ProcessPoolExecutor"
print("Рекомендации по типу нагрузки проверены")
