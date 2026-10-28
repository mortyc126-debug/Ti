const signalAtClose = [1, 0, -1, 1];
const tradableNextBar = [null, ...signalAtClose.slice(0, -1)];
console.log(tradableNextBar);
