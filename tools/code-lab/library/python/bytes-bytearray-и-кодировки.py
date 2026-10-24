text = "Привет"
data = text.encode("utf-8")
print(data)
print(data.decode("utf-8"))
mutable = bytearray(data)
mutable[0] = ord("A")  # изменяем первый байт
print(mutable[0])
print(isinstance(data, bytes), isinstance(mutable, bytearray))
