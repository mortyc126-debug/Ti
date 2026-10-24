import csv
from io import StringIO
текст = "тикер,цена\nSBER,275.4\nYNDX,4120.0\n"
with StringIO(текст) as файл:
    for строка in csv.DictReader(файл):
        print(строка["тикер"], float(строка["цена"]))
