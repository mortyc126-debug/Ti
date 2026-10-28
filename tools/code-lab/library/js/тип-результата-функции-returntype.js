function createUser(name) {
  return { name, active: true };
}

/** @typedef {ReturnType<typeof createUser>} User */

/** @param {User} user */
function describeUser(user) {
  return `${user.name}: ${user.active ? "активен" : "неактивен"}`;
}

console.log(describeUser(createUser("Мира")));
