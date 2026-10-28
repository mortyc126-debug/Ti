function validUser(value) {
  return value !== null && typeof value === "object" &&
    typeof value.id === "string" && typeof value.name === "string";
}
console.log(validUser({ id: "u1", name: "Анна" }));
