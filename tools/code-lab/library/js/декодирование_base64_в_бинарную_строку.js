const бинарная = atob("0J/RgNC40LLQtdGC");
console.log(бинарная.length);

const байты = Uint8Array.from(бинарная, символ => символ.charCodeAt(0));
console.log(new TextDecoder().decode(байты));
