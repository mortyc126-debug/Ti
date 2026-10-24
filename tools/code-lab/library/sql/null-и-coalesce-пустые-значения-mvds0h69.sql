CREATE TABLE цены (бумага TEXT, цена REAL);
INSERT INTO цены VALUES ('А', 100), ('Б', NULL);

SELECT бумага, COALESCE(цена, 0) AS цена_или_0
FROM цены
WHERE цена IS NULL OR цена > 50;