function handler(причина) {
  console.log("необработанный отказ:", причина.message);
}
process.on("unhandledRejection", handler);
Promise.reject(new Error("промис без обработчика"));
