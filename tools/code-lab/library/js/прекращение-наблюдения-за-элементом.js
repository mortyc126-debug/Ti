const наблюдаемые = new Set();
const observer = { // вместо настоящего IntersectionObserver
  observe(element) { наблюдаемые.add(element); },
  unobserve(element) { наблюдаемые.delete(element); }
};
const element = document.createElement("div");
const другой = document.createElement("div");
observer.observe(element);
observer.observe(другой);
observer.unobserve(element);
console.log(наблюдаемые.size);
