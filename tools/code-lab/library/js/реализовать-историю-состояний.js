function createHistory(initialState) {
  let states = [initialState], index = 0;
  return {
    current: () => states[index],
    push(next) { states = states.slice(0, index + 1); states.push(next); index++; },
    undo() { if (index > 0) index--; return states[index]; },
    redo() { if (index < states.length - 1) index++; return states[index]; }
  };
}
const history = createHistory({count:0});
history.push({count:1});
console.log(history.undo());
