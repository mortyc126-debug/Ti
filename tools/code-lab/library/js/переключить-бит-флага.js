const BOLD = 1;
const ITALIC = 2;

let style = BOLD;

style ^= ITALIC;
console.log(style, (style & ITALIC) !== 0);

style ^= ITALIC;
console.log(style, (style & ITALIC) !== 0);
