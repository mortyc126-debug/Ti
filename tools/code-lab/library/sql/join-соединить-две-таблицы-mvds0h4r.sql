CREATE TABLE эмитенты (id INTEGER, название TEXT);
CREATE TABLE выпуски (эмитент_id INTEGER, имя TEXT);
INSERT INTO эмитенты VALUES (1, 'Минфин'), (2, 'Банк');
INSERT INTO выпуски VALUES (1, 'ОФЗ-1'), (1, 'ОФЗ-2'), (2, 'Бонд-1');

SELECT э.название, в.имя
FROM выпуски AS в
JOIN эмитенты AS э ON э.id = в.эмитент_id
ORDER BY в.имя;