const visited = new Set(["home", "tools"]);
visited.add("colors");
visited.add("home");
console.log(visited.has("colors"));
console.log(visited.size);