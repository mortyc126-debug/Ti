const users = [
  { name: "Аня", active: false },
  { name: "Лев", active: true }
];
const user = users.find(item => item.active);
console.log(user.name);