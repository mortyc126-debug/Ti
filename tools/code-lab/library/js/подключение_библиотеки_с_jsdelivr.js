const скрипт = document.createElement("script");
скрипт.src = "https://cdn.jsdelivr.net/npm/dayjs@1.11.10/dayjs.min.js";
скрипт.onload = () => console.log(dayjs("2026-10-28").format("DD.MM.YYYY"));
скрипт.onerror = () => console.error("CDN недоступен");
document.head.appendChild(скрипт);
