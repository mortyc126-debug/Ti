function applyValidatedBatch(current, operations, validate) {
  const errors = operations.flatMap((operation, index) => {
    const message = validate(operation, current);
    return message ? [{ index, operation, message }] : [];
  });
  if (errors.length) return { ok: false, errors, value: current };
  let next = current;
  for (const operation of operations) next = operation.apply(next);
  return { ok: true, errors: [], value: next };
}
// Это атомарность только на уровне возвращаемого значения, не транзакция внешней БД.
