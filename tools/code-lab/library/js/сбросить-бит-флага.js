const READ = 1;
const WRITE = 2;
const EXECUTE = 4;

let flags = READ | WRITE | EXECUTE;
console.log(flags);

flags &= ~WRITE;
console.log(flags, (flags & WRITE) !== 0);
