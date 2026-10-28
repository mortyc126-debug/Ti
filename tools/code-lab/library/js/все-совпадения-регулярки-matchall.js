const report = "Заказы: A-101, B-202, C-303";
const matches = report.matchAll(/([A-Z])-(\d+)/g);

for (const match of matches) {
  console.log(`${match[1]} → ${match[2]} (позиция ${match.index})`);
}
