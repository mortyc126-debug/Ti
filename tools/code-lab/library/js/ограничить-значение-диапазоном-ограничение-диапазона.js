const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
console.log(clamp(120, 0, 100));
