function logMessage(level, ...parts) {
  console.log(`[${level}] ${parts.join(" ")}`);
}

logMessage("INFO", "Сервер", "запущен", "на порту", 3000);
