async function loadData() {
  const response = await fetch("/api/colors");
  if (!response.ok) {
    throw new Error("Не удалось загрузить данные");
  }
  const data = await response.json();
  console.log(data);
}

loadData().catch(error => console.log(error.message));