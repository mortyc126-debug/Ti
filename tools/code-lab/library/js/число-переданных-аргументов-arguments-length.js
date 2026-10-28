function countArguments() {
  return arguments.length;
}

console.log(countArguments());
console.log(countArguments(1, 2, 3));

function outer() {
  const arrow = () => arguments.length;
  return arrow();
}

console.log(outer("a", "b"));
