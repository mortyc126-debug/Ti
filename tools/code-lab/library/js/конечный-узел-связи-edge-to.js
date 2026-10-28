const edges = [
  { from: "A", to: "B" },
  { from: "A", to: "C" },
  { from: "B", to: "C" },
];

const incoming = {};
for (const edge of edges) {
  incoming[edge.to] = (incoming[edge.to] ?? 0) + 1;
}

console.log(incoming);
