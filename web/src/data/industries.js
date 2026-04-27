// Иерархический справочник отраслей. Используется в Portfolio (структура
// по отраслям), Issuer-окне и при импорте каталога эмитентов. Список —
// рабочий, согласован с пользовательницей; правки бить через PR.

export const INDUSTRY_GROUPS = [
  { id: 'raw',    label: 'Ресурсы и сырьё',          items: [
    { id: 'agro',         label: 'Агро и пищевая промышленность' },
    { id: 'metals',       label: 'Металлы и добыча руд' },
    { id: 'oil-gas',      label: 'Нефть и газ' },
  ]},
  { id: 'manuf',  label: 'Обрабатывающая промышленность', items: [
    { id: 'auto',         label: 'Автомобили, транспортная техника' },
    { id: 'wood',         label: 'Дерево, бумага, печать' },
    { id: 'machinery',    label: 'Машиностроение' },
    { id: 'furniture',    label: 'Мебель и прочее производство' },
    { id: 'metalware',    label: 'Металлоизделия' },
    { id: 'plastics',     label: 'Пластмассы и резина' },
    { id: 'building-mat', label: 'Стройматериалы' },
    { id: 'textile',      label: 'Текстиль и одежда' },
    { id: 'pharma',       label: 'Фармацевтика' },
    { id: 'chemistry',    label: 'Химия и удобрения' },
    { id: 'electronics',  label: 'Электроника и электрооборудование' },
  ]},
  { id: 'energy', label: 'Энергетика и ЖКХ',         items: [
    { id: 'utilities',    label: 'Электроэнергетика и ЖКХ' },
  ]},
  { id: 'build',  label: 'Стройка и недвижимость',   items: [
    { id: 'realestate',   label: 'Недвижимость (аренда, управление)' },
    { id: 'construction', label: 'Строительство и девелопмент' },
  ]},
  { id: 'trade',  label: 'Торговля',                 items: [
    { id: 'retail',       label: 'Ритейл и опт' },
  ]},
  { id: 'transport', label: 'Транспорт',             items: [
    { id: 'logistics',    label: 'Транспорт и логистика' },
  ]},
  { id: 'it-media', label: 'IT, связь и медиа',      items: [
    { id: 'media',        label: 'Медиа и связь' },
    { id: 'telecom',      label: 'Телеком' },
    { id: 'it',           label: 'IT и разработка ПО' },
  ]},
  { id: 'finance', label: 'Финансы',                 items: [
    { id: 'banks',        label: 'Банки' },
    { id: 'leasing',      label: 'Лизинг' },
    { id: 'mfo',          label: 'МФО и потребительское кредитование' },
    { id: 'insurance',    label: 'Страхование' },
    { id: 'holdings',     label: 'Холдинги / SPV' },
  ]},
  { id: 'services', label: 'Услуги и разное',        items: [
    { id: 'rental',       label: 'Аренда, услуги, персонал' },
    { id: 'hospitality',  label: 'Гостиницы и общепит' },
    { id: 'healthcare',   label: 'Здравоохранение' },
    { id: 'entertainment',label: 'Искусство, спорт, развлечения' },
    { id: 'science',      label: 'Наука и R&D' },
    { id: 'education',    label: 'Образование' },
    { id: 'consulting',   label: 'Проф. услуги, консалтинг' },
    { id: 'services-etc', label: 'Прочие услуги' },
  ]},
  { id: 'other',  label: 'Прочее',                   items: [
    { id: 'other',        label: 'Прочее' },
  ]},
];

// Плоский словарь id → { label, groupId, groupLabel }. Строится один раз.
export const INDUSTRIES = (() => {
  const out = {};
  for(const g of INDUSTRY_GROUPS){
    for(const it of g.items){
      out[it.id] = { id: it.id, label: it.label, groupId: g.id, groupLabel: g.label };
    }
  }
  return out;
})();

export function industryLabel(id){
  return INDUSTRIES[id]?.label ?? id ?? '—';
}

export function industryGroup(id){
  return INDUSTRIES[id]?.groupId ?? 'other';
}
