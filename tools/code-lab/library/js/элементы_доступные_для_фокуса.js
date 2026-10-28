const контейнер = document.querySelector("dialog");

const доступные = контейнер.querySelectorAll(
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
);

console.log(доступные.length);
