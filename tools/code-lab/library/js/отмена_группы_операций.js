const контроллеры = [new AbortController(), new AbortController(), new AbortController()];

контроллеры.forEach(контроллер => контроллер.abort());

console.log(контроллеры.map(контроллер => контроллер.signal.aborted));
