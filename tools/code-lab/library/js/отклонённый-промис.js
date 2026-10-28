const отказ = Promise.reject(new Error("сервер недоступен"));
отказ.catch(ошибка => console.log("поймали:", ошибка.message));
