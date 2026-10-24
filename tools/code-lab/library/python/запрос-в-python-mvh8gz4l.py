import json
from urllib.request import urlopen

with urlopen('https://api.example.com/users') as response:
    data = json.load(response)

print(data)