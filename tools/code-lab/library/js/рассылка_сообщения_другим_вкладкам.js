const канал = new BroadcastChannel("updates");

канал.postMessage({ тип: "обновлено", время: Date.now() });
