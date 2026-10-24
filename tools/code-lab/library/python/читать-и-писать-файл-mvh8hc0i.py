with open('data.txt', 'w', encoding='utf-8') as f:
    f.write('Привет\n')

with open('data.txt', encoding='utf-8') as f:
    print(f.read())