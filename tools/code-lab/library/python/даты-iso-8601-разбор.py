from datetime import datetime, timezone

value = datetime.fromisoformat("2026-10-23T12:30:00+03:00")
print(value.astimezone(timezone.utc).isoformat())
