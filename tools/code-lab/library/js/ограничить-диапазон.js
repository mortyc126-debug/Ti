const clamp = (x, min, max) => Math.min(max, Math.max(min, x));
console.log(clamp(120, 0, 100));
console.log(clamp(-5, 0, 100));
