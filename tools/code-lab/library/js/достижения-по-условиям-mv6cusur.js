const score = 120;
const achievements = [
  { title: "Первый шаг", unlocked: score >= 10 },
  { title: "Сотня очков", unlocked: score >= 100 },
  { title: "Мастер", unlocked: score >= 500 }
];

const unlocked = achievements.filter(item => item.unlocked);
console.log(unlocked.map(item => item.title));