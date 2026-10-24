from datetime import datetime, timezone
from zoneinfo import ZoneInfo

moscow = ZoneInfo("Europe/Moscow")
local = datetime(2026, 10, 23, 10, 0, tzinfo=moscow)
utc = local.astimezone(timezone.utc)
assert utc.tzinfo is timezone.utc
print(utc.isoformat())
