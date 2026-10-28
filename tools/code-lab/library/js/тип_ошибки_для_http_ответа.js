class HttpError extends Error {
  constructor(ответ) {
    super(`HTTP ${ответ.status}`);
    this.name = "HttpError";
    this.status = ответ.status;
  }
}

const ответ = new Response("", { status: 404 });
try {
  if (!ответ.ok) throw new HttpError(ответ);
} catch (ошибка) {
  console.log(ошибка.name, ошибка.status, ошибка instanceof HttpError);
}
