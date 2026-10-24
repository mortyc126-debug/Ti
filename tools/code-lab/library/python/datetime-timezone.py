from datetime import datetime, timezone

событие = datetime.now(timezone.utc)
print(событие.tzinfo is not None)
print(событие.isoformat())
