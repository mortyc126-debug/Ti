from contextlib import suppress

# Пример: безопасное чтение файла, если он не существует
with suppress(FileNotFoundError):
    with open('несуществующий_файл.txt', 'r') as file:
        print(file.read())

print("Файл успешно обработан или ошибка проигнорирована.")