CREATE TABLE бумаги (имя TEXT, тип TEXT);
INSERT INTO бумаги VALUES ('ОФЗ-1', 'гос'), ('ОФЗ-2', 'гос'), ('Бонд', 'корп');

SELECT DISTINCT тип FROM бумаги;
SELECT имя FROM бумаги WHERE имя LIKE 'ОФЗ%' LIMIT 1;