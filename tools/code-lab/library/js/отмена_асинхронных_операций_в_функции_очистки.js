function запуститьЗагрузку(адрес, принять) {
  const контроллер = new AbortController();

  fetch(адрес, { signal: контроллер.signal })
    .then(ответ => ответ.json())
    .then(принять)
    .catch(ошибка => {
      if (ошибка.name !== "AbortError") throw ошибка;
    });

  return () => контроллер.abort();
}

// useEffect(() => запуститьЗагрузку("/api/список", setСписок), []);
