const nd = {
  id: "узел-первый",
  blockId: "блок-основной",
  desc: "Узел с описанием",
  fields: { code: "console.log('привет')" },
  src: { id: "источник-первый", title: "Исходный пример", desc: "Описание исходного примера" }
};

console.log(nd.src.desc);
