const корень = await navigator.storage.getDirectory();
const дескриптор = await корень.getFileHandle("data.txt", { create: true });

const поток = await дескриптор.createWritable();
await поток.write("Привет");
await поток.close();
