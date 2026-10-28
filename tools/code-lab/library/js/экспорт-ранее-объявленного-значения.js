const appName = "Заметки";

function greet(user) {
  return `${appName}: привет, ${user}!`;
}

export { appName, greet };

console.log(greet("Мира"));
