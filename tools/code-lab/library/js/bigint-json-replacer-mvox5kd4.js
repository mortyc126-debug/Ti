const данные = { id: 9007199254740993n };
const json = JSON.stringify(данные, (_, значение) => typeof значение === "bigint" ? значение.toString() : значение);
console.log(json);
