with open("заметка.txt", "w", encoding="utf-8") as f:
    f.write("привет\nвторая строка\n")

with open("заметка.txt", encoding="utf-8") as f:
    строки = f.read().splitlines()

print(строки)