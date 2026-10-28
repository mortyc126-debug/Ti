class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    Error.captureStackTrace(this, this.constructor);
  }
}

function validate(age) {
  if (age < 0) throw new ValidationError("Возраст отрицательный");
}

try {
  validate(-1);
} catch (error) {
  const [title, firstFrame] = error.stack.split("\n");
  console.log(title);
  console.log(firstFrame.trim().split(" ").slice(0, 2).join(" "));
}
