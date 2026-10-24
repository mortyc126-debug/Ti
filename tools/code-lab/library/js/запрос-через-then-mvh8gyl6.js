fetch('https://api.example.com/users')
  .then(response => response.json())
  .then(data => console.log(data));