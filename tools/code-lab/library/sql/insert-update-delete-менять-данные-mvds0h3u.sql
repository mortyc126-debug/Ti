CREATE TABLE задачи (id INTEGER PRIMARY KEY, текст TEXT, готово INTEGER DEFAULT 0);

INSERT INTO задачи (текст) VALUES ('купить хлеб'), ('написать тест');
UPDATE задачи SET готово = 1 WHERE id = 1;
DELETE FROM задачи WHERE id = 2;

SELECT * FROM задачи;