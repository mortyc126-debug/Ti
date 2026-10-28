process.on("warning", предупреждение => {
  console.log(предупреждение.name, предупреждение.message);
});
process.emitWarning("память почти заполнена");
