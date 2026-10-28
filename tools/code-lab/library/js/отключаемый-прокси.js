const target = { имя: "Анна" };
const handler = {};
const { proxy, revoke } = Proxy.revocable(target, handler);
console.log(proxy.имя);
revoke();
try {
  console.log(proxy.имя);
} catch (ошибка) {
  console.log(ошибка instanceof TypeError);
}
