const location = { reload() { console.log("страница перезагружена"); } }; // вместо window.location
navigator.serviceWorker.addEventListener("controllerchange", () => location.reload());
