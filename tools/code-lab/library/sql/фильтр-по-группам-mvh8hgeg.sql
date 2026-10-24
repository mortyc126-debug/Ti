SELECT user_id, SUM(total) AS sum_total
FROM orders
GROUP BY user_id
HAVING SUM(total) > 1000;