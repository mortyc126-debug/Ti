try {
  const [дескриптор] = await window.showOpenFilePicker({
    types: [{ description: "Текст", accept: { "text/plain": [".txt"] } }],
  });
  console.log(дескриптор.name);
} catch (ошибка) {
  if (ошибка.name !== "AbortError") throw ошибка;
}
