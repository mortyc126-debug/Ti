const замок = await navigator.wakeLock.request("screen");
console.log("Экран не погаснет:", !замок.released);

await замок.release();
console.log("Блокировка снята:", замок.released);