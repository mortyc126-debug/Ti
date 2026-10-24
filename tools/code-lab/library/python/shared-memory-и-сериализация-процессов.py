import pickle

payload = {"values": list(range(1000))}
serialized = pickle.dumps(payload, protocol=pickle.HIGHEST_PROTOCOL)
restored = pickle.loads(serialized)
assert restored == payload
print("Размер сериализованного payload:", len(serialized), "байт")
