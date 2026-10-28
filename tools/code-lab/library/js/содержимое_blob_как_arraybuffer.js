const файл = new Blob(["Привет"]);
const байты = new Uint8Array(await файл.arrayBuffer());

console.log(байты.length);
