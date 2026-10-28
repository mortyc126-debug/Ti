const ref = { current: document.createElement("input") }; // вместо useRef
document.body.append(ref.current);

ref.current?.focus();
console.log(document.activeElement === ref.current);

const пустая = { current: null };
пустая.current?.focus();
console.log("пустая ссылка не вызывает ошибку");
