function migrateData(record, migrations, targetVersion) {
  let data = record.data;
  let version = record.version ?? 0;
  if (version > targetVersion) throw new Error('Данные новее поддерживаемой схемы');
  while (version < targetVersion) {
    const migrate = migrations[version];
    if (typeof migrate !== 'function') throw new Error(`Нет миграции версии ${version} -> ${version + 1}`);
    data = migrate(data);
    version++;
  }
  return { version, data };
}
// migrateData({version:0,data:{name:'A'}}, {0: d => ({...d, active:true})}, 1);
