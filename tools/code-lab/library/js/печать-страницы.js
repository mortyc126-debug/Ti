const printStyle = document.createElement("style");
printStyle.textContent = "@media print { .no-print { display: none; } }";
document.head.append(printStyle);

const report = document.createElement("article");
report.innerHTML = "<h1>Отчёт за неделю</h1><p>Продажи выросли на 12%.</p>";

const printButton = document.createElement("button");
printButton.textContent = "Распечатать";
printButton.className = "no-print";
printButton.addEventListener("click", () => window.print());

document.body.append(report, printButton);
