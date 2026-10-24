class InvalidAgeError(Exception):
    """Исключение для некорректного возраста."""
    def __init__(self, age):
        self.age = age
        super().__init__(f"Возраст {age} недопустим!")

def check_age(age):
    if age < 0:
        raise InvalidAgeError(age)
    print(f"Возраст {age} допустим.")

check_age(25)
try:
    check_age(-5)
except InvalidAgeError as ошибка:
    print(f"Перехвачено пользовательское исключение: {ошибка}")
