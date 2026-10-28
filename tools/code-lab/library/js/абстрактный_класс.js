abstract class Основа { abstract run(): void; }
class Задача extends Основа { run() { console.log("готово"); } }
new Задача().run();
