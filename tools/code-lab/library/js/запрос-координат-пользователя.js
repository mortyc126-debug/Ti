function onSuccess(позиция) {
  console.log(позиция.coords.latitude, позиция.coords.longitude);
}
function onError(ошибка) {
  console.log("не удалось получить координаты:", ошибка.message);
}
navigator.geolocation.getCurrentPosition(onSuccess, onError);
