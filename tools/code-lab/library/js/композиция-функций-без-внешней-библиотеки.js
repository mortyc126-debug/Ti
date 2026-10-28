const compose = (f, g) => x => f(g(x));
const clean = text => text.trim();
const upper = text => text.toUpperCase();
console.log(compose(upper, clean)("  hello "));
