async function firstSuccessful(strategies, { accept = value => value != null } = {}) {
  const errors = [];
  for (const strategy of strategies) {
    try {
      const value = await strategy.run();
      if (accept(value)) return { value, source: strategy.name, errors };
      errors.push({ source: strategy.name, error: new Error('Результат не принят') });
    } catch (error) { errors.push({ source: strategy.name, error }); }
  }
  return { value: null, source: null, errors };
}
// const result = await firstSuccessful([{name:'cache',run:readCache},{name:'api',run:fetchApi}]);
