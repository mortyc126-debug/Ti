const база = [];   // хранилище записей

// C — create: добавить запись
function добавить(имя, цена){ база.push({ id: база.length + 1, имя, цена }); }
// R — read: найти по части имени
function найти(текст){ return база.filter(z => z.имя.includes(текст)); }
// D — delete: убрать по id
function удалить(id){
  const i = база.findIndex(z => z.id === id);
  if(i >= 0) база.splice(i, 1);
}

добавить("ОФЗ 26238", 61.2);
добавить("Сегежа 2P5R", 88.0);
добавить("ОФЗ 26241", 79.5);

console.log("всего:", база.length);
console.log("поиск ОФЗ:", JSON.stringify(найти("ОФЗ")));
удалить(2);
console.log("после удаления:", JSON.stringify(база));