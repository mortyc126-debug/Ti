const отмена = new AbortController();
fetch("/api/данные", { signal: отмена.signal }).catch(ошибка => console.log(ошибка.name));
отмена.abort();
