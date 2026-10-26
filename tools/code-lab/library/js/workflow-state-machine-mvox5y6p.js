function createStateMachine(initial, transitions) {
  let state = initial;
  return {
    get state() { return state; },
    can(next) { return (transitions[state] ?? []).includes(next); },
    transition(next) {
      if (!this.can(next)) throw new Error(`Недопустимый переход: ${state} -> ${next}`);
      const previous = state; state = next;
      return { previous, current: state };
    }
  };
}
const machine = createStateMachine('idle', { idle:['running'], running:['done','failed'], failed:['running'] });
console.log(machine.transition('running'));
