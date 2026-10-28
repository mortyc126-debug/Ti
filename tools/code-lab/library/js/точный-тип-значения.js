for (const value of [[], {}, null, new Date(0), /а/, 42, "строка"]) {
  console.log(Object.prototype.toString.call(value));
}
