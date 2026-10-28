const recorder = new EventTarget(); // вместо настоящего MediaRecorder
const chunks = [];
recorder.addEventListener("dataavailable", event => chunks.push(event.data));

for (const часть of ["фрагмент-первый", "фрагмент-второй"]) {
  const событие = new Event("dataavailable");
  событие.data = часть;
  recorder.dispatchEvent(событие);
}
console.log(chunks);
