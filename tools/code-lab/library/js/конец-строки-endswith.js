const files = ["photo.png", "notes.txt", "archive.tar.gz"];

for (const file of files) {
  console.log(`${file}: ${file.endsWith(".png") ? "картинка" : "не картинка"}`);
}
