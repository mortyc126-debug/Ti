/** @typedef {{ id: number, name: string }} User */

/** @param {User} user */
export function describeUser(user) {
  return `${user.id}: ${user.name}`;
}

console.log(describeUser({ id: 1, name: "Мира" }));
