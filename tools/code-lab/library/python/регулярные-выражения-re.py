import re
текст = "SBER 275.4; YNDX 4120.0; LKOH 6820"
цены = re.findall(r"\d+(?:\.\d+)?", текст)
print([float(цена) for цена in цены])
