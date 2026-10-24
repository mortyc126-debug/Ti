import csv
import io

buffer = io.StringIO(newline="")
writer = csv.writer(buffer)
writer.writerow(["symbol", "comment"])
writer.writerow(["ABC", 'цена, "важно"'])
print(buffer.getvalue(), end="")
