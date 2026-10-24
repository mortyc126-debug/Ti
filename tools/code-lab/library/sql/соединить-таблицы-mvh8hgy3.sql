SELECT users.name, orders.total
FROM orders
JOIN users ON users.id = orders.user_id;