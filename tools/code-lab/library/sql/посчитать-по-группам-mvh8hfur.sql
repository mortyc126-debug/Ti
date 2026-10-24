SELECT city, COUNT(*) AS cnt
FROM users
GROUP BY city;