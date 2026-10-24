import csv
from io import StringIO

текст = "тикер,цена\nSi,125.5\nRI,98000\n"
строки = csv.DictReader(StringIO(текст))
первая = next(строки)
print([первая["тикер"], первая["цена"]])
