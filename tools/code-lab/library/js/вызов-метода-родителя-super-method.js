class Logger {
  log(message) {
    return `[LOG] ${message}`;
  }
}

class TimeLogger extends Logger {
  log(message) {
    return `${super.log(message)} (12:00)`;
  }
}

console.log(new TimeLogger().log("Сервер запущен"));
