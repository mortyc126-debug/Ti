const регистрация = await navigator.serviceWorker.ready;
await регистрация.update();

console.log("Ожидает активации:", Boolean(регистрация.waiting));
