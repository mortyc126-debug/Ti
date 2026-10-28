import * as XLSX from "xlsx";

const книга = XLSX.read(данныеФайла, { type: "array" });
const лист  = книга.Sheets[книга.SheetNames[0]]; // первый лист
const строки = XLSX.utils.sheet_to_json(лист, { header: 1 });
// строки → [[ячейка, ячейка, …], …]