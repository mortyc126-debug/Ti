const config = { mode: "dev" } as const;

type Режим = typeof config.mode;
const режим: Режим = "dev";

console.log(режим);
