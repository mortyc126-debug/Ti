CREATE TABLE бумаги (имя TEXT, доходность REAL, лет INTEGER);
INSERT INTO бумаги VALUES ('А', 9.1, 3), ('Б', 12.4, 7), ('В', 7.7, 2);

SELECT имя, доходность
FROM бумаги
WHERE доходность > 8
ORDER BY доходность DESC;