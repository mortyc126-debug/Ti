const decoder = new TextDecoder("utf-8");
const часть1 = decoder.decode(bytes1, { stream: true });
const часть2 = decoder.decode(bytes2, { stream: true });
const конец = decoder.decode();
console.log(часть1 + часть2 + конец);
