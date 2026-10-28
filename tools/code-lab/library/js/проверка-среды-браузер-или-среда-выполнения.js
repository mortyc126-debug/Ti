const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
const isNode = typeof process !== "undefined" && Boolean(process.versions?.node);
console.log({ isBrowser, isNode });
