async function* числа() { yield 4; yield 5; }
console.log(await Array.fromAsync(числа()));