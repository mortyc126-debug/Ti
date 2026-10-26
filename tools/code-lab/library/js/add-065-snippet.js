const response = { data: { user: { name: "Анна" } } };
const name = response.data?.user?.name ?? "Без имени";
console.log(name);
