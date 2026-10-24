async function отправить(данные) {
  const ответ = await fetch("https://example.com/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(данные),
  });
  return ответ.json();
}

отправить({ имя: "Аня" }).then(console.log);