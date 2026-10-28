if (typeof window !== "undefined" && "IntersectionObserver" in window) {
  console.log("Можно использовать IntersectionObserver");
} else {
  console.log("Нужен запасной вариант");
}
