const byId = new Map(users.map(u => [u.id, u]));

const result = orders.map(o => ({
  ...o,
  user: byId.get(o.userId),
}));