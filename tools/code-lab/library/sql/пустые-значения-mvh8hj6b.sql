SELECT name, COALESCE(city, 'не указан') AS city
FROM users;

SELECT name
FROM users
WHERE city IS NULL;