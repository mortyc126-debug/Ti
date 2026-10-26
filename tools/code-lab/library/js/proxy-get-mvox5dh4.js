const исходный = { цена: 10 };
const прокси = new Proxy(исходный, {
  get(цель, ключ, получатель) {
    if (ключ === "цена") return Reflect.get(цель, ключ, получатель) * 2;
    return Reflect.get(цель, ключ, получатель);
  }
});
console.log(прокси.цена);
