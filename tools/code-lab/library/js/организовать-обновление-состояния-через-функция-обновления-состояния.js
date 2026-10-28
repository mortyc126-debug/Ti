function reducer(state, action) {
  switch (action.type) {
    case 'increment': return { ...state, count: state.count + (action.amount ?? 1) };
    case 'set-name': return { ...state, name: action.name };
    case 'reset': return { count: 0, name: '' };
    default: throw new Error(`Неизвестное действие: ${action.type}`);
  }
}
console.log(reducer({count:2, name:'A'}, {type:'increment', amount:3}));
