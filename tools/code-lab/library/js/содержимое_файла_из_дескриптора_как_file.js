const [дескриптор] = await window.showOpenFilePicker();
const файл = await дескриптор.getFile();

console.log(файл.name, файл.size);
console.log(await файл.text());
