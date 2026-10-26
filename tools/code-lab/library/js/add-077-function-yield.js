function* ids() {
  yield 101;
  yield 102;
  yield 103;
}
for (const id of ids()) console.log(id);
