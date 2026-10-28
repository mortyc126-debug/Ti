const дата = Temporal.PlainDate.from("2026-01-01");
const позже = дата.add({ days: 30 });

console.log(позже.toString());
