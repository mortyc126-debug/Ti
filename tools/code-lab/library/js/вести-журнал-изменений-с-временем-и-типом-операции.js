function createChangeLog(now = () => new Date().toISOString()) {
  const entries = [];
  return {
    append({ entityId, action, before = null, after = null, actor = null }) {
      const entry = Object.freeze({ id: entries.length + 1, at: now(), entityId, action, before, after, actor });
      entries.push(entry);
      return entry;
    },
    list(filter = () => true) { return entries.filter(filter); }
  };
}
const log = createChangeLog(); log.append({entityId:7, action:'update', before:{x:1}, after:{x:2}});
