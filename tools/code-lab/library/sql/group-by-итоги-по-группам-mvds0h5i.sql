CREATE TABLE сделки (бумага TEXT, сумма INTEGER);
INSERT INTO сделки VALUES ('А', 100), ('Б', 50), ('А', 30);

SELECT бумага, COUNT(*) AS штук, SUM(сумма) AS всего
FROM сделки
GROUP BY бумага
ORDER BY бумага;