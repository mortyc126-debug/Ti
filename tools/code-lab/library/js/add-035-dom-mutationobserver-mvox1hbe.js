const target = document.querySelector("#items");
const observer = new MutationObserver(records => console.log("Изменений:", records.length));
observer.observe(target, { childList: true, subtree: true });
// observer.disconnect() — остановить наблюдение
