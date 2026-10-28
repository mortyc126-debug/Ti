const stack = new DisposableStack();

stack.defer(() => console.log("первый ресурс закрыт"));
stack.defer(() => console.log("второй ресурс закрыт"));

console.log("до dispose:", stack.disposed);
stack.dispose();
console.log("после dispose:", stack.disposed);
