const user = { name: "Мира", email: "  MIRA@Example.com " };

user.email &&= user.email.trim().toLowerCase();
user.phone &&= user.phone.trim();

console.log(user);
