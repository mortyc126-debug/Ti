import os


def required_env(name: str, environ: dict[str, str] | None = None) -> str:
    source = os.environ if environ is None else environ
    value = source.get(name, "").strip()
    if not value:
        raise ValueError(f"Не задана обязательная переменная {name}")
    return value

assert required_env("APP_MODE", {"APP_MODE": " test "}) == "test"
try:
    required_env("API_TOKEN", {})
except ValueError as exc:
    print(type(exc).__name__, str(exc))
