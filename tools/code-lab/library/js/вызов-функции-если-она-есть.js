function download(url, onDone) {
  console.log(`Загрузка ${url}`);
  onDone?.("готово");
}

download("a.txt", result => console.log(`Колбэк: ${result}`));
download("b.txt");
