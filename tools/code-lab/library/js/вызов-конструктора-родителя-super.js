class AppError extends Error {
  constructor(...args) {
    super(...args);
    this.name = "AppError";
  }
}

const error = new AppError("Страница не найдена", { cause: "404" });

console.log(error.name, error.message, error.cause);
console.log(error instanceof Error);
