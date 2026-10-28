class Сервис {
  constructor(private readonly имя: string) {}

  приветствие(): string {
    return `Сервис ${this.имя}`;
  }
}

console.log(new Сервис("почта").приветствие());
