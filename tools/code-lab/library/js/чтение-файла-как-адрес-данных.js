const file = new File(["Привет"], "привет.txt", { type: "text/plain" });
const reader = new FileReader();
reader.addEventListener("load", () => console.log(reader.result));
reader.readAsDataURL(file);
