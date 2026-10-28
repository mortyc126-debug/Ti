async function* страницы(адрес) {
  while (адрес) {
    const ответ = await fetch(адрес);
    if (!ответ.ok) throw new Error(`HTTP ${ответ.status}`);
    const данные = await ответ.json();
    yield данные.items;
    адрес = данные.next;
  }
}
