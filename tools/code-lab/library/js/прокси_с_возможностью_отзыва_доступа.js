const { proxy, revoke } = Proxy.revocable({ секрет: 1 }, {});

console.log(proxy.секрет);
revoke();

try {
  console.log(proxy.секрет);
} catch (ошибка) {
  console.log(ошибка.name);
}
