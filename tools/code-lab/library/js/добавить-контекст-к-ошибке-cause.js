function loadProfile(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Не удалось загрузить профиль", { cause: error });
  }
}

try {
  loadProfile("{");
} catch (wrapped) {
  console.log(wrapped.message);
  console.log("Причина:", wrapped.cause.name);
}
