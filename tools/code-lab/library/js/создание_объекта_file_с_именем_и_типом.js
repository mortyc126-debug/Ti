const файл = new File(["Привет"], "приветствие.txt", { type: "text/plain" });

console.log(файл.name, файл.type, файл.size);
