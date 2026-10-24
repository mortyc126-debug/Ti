async function load() {
  const response = await fetch('https://api.example.com/users');
  const data = await response.json();
  console.log(data);
}

load();