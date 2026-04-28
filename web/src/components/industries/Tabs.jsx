// Маленький табс-свитчер для страницы «Отрасли». Стиль — как
// uppercase-кнопки в верхнем меню.

export default function Tabs({ items, value, onChange }){
  return (
    <div className="flex gap-1 border-b border-border">
      {items.map(it => {
        const active = it.id === value;
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onChange(it.id)}
            className={[
              'px-4 py-2 text-xs font-mono uppercase tracking-wider transition-colors',
              active
                ? 'text-acc border-b-2 border-acc -mb-px'
                : 'text-text2 hover:text-text border-b-2 border-transparent -mb-px',
            ].join(' ')}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
