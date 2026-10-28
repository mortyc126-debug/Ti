const данные = new Blob(["Привет из буфера"], { type: "text/plain" });
await navigator.clipboard.write([
  new ClipboardItem({ "text/plain": данные }),
]);
