const навигация = performance.getEntriesByType("navigation")[0];
console.log(времяЗагрузки(навигация));
function времяЗагрузки(запись) {
  return запись ? Math.round(запись.domContentLoadedEventEnd) : "нет данных вне браузера";
}
