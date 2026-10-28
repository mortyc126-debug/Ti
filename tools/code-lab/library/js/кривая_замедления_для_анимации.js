const easeOut = t => 1 - (1 - t) ** 3;

console.log([0, 0.25, 0.5, 0.75, 1].map(easeOut));
