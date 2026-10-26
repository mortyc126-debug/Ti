function memoizeLast(fn) {
  let hasValue = false, lastArgs = [], lastResult;
  return (...args) => {
    if (hasValue && args.length === lastArgs.length && args.every((arg, i) => Object.is(arg, lastArgs[i]))) return lastResult;
    lastArgs = args; lastResult = fn(...args); hasValue = true;
    return lastResult;
  };
}
const total = memoizeLast((a, b) => a + b);
console.log(total(2,3), total(2,3));
