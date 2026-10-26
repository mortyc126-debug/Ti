const row = document.createElement("li");
row.dataset.id = String(record.id);
row.textContent = record.name;
list.append(row);
