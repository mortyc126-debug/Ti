function planReconciliation(localRows, remoteRows) {
  const local = new Map(localRows.map(row => [row.id, row]));
  const remote = new Map(remoteRows.map(row => [row.id, row]));
  const plan = { insert: [], update: [], delete: [], unchanged: [] };
  for (const [id, remoteRow] of remote) {
    if (!local.has(id)) plan.insert.push(remoteRow);
    else if (JSON.stringify(local.get(id)) !== JSON.stringify(remoteRow)) plan.update.push({ id, before: local.get(id), after: remoteRow });
    else plan.unchanged.push(remoteRow);
  }
  for (const [id, localRow] of local) if (!remote.has(id)) plan.delete.push(localRow);
  return plan;
}
// План можно проверить до применения; сравнение JSON-подобных записей зависит от сериализации.
