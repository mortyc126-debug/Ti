let введено = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", часть => { введено += часть; });
process.stdin.on("end", () => console.log("получено символов:", введено.length));
