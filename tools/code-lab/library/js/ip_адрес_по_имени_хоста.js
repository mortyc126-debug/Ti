import dns from "node:dns/promises";

const { address } = await dns.lookup("localhost");
console.log(address);
