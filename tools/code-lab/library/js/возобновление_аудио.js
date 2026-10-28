const звук = new AudioContext();
// Выполнить после действия пользователя.
await звук.resume();
console.log(звук.state);
