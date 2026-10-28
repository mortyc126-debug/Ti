process.on("exit", код => console.log("код выхода:", код));
setTimeout(() => console.log("отложенная работа выполнена"), 10);
process.exitCode = 1;
