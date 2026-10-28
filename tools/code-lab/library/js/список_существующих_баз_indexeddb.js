const базы = await indexedDB.databases();

console.log(базы.map(база => `${база.name} v${база.version}`));
