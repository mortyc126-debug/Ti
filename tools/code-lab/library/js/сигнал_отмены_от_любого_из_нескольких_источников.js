const вручную = new AbortController();
const общий = AbortSignal.any([вручную.signal, AbortSignal.timeout(5000)]);

вручную.abort();
console.log(общий.aborted);
