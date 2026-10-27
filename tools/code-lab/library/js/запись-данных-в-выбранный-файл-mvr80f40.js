const дескриптор = await window.showSaveFilePicker({ suggestedName: "заметка.txt" });
const поток = await дескриптор.createWritable();

await поток.write("Текст заметки");
await поток.close();