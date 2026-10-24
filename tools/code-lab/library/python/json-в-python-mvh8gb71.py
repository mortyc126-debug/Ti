import json

data = json.loads('{"name": "Анна", "age": 31}')
text = json.dumps(data, ensure_ascii=False, indent=2)
print(text)
