const openButton = document.createElement("button");
openButton.textContent = "Открыть окно отчёта";
document.body.append(openButton);

openButton.addEventListener("click", () => {
  const reportWindow = window.open("", "report", "width=400,height=200");
  reportWindow.document.write(
    '<p>Отчёт готов</p><button onclick="window.close()">Закрыть</button>'
  );
});
