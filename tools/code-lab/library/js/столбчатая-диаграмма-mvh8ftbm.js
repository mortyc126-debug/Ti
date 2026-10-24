const data = [30, 80, 45, 60];

const bars = data.map((v, i) =>
  `<rect x="${i * 30}" y="${100 - v}" width="24" height="${v}" fill="#3a86ff" />`
).join('');

document.querySelector('svg').innerHTML = bars;