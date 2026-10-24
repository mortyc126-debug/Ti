fetch("/api/status")
  .then(response => response.json())
  .then(data => console.log(data.status))
  .catch(error => console.log("Ошибка:", error.message));