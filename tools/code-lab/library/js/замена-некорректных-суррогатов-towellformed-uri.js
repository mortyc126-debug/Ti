const brokenText = "abc\uD800def";

try {
  encodeURIComponent(brokenText);
} catch (error) {
  console.log(error.name);
}

console.log(encodeURIComponent(brokenText.toWellFormed()));
