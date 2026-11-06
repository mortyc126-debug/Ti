function сложить(первое: number, второе: number): number {
  return первое + второе;
}
type ПараметрыСложения = Parameters<typeof сложить>;
const аргументы: ПараметрыСложения = [2, 3];
console.log(сложить(...аргументы));
