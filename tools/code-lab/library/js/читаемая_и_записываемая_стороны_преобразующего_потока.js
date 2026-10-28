const { readable, writable } = new TransformStream({
  transform(фрагмент, управление) {
    управление.enqueue(фрагмент.toUpperCase());
  },
});

const писатель = writable.getWriter();
писатель.write("привет");
писатель.close();

for await (const часть of readable) {
  console.log(часть);
}
