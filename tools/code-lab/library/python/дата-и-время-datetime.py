from datetime import date, timedelta
сегодня = date(2026, 10, 23)
через_неделю = сегодня + timedelta(days=7)
print(сегодня.isoformat(), через_неделю.isoformat())
