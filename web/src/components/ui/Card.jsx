// Карточка-контейнер. Заголовок + опциональный action-блок справа.
// padded=false для случаев, когда внутри таблица и нужен край-в-край.

export default function Card({
  title,
  subtitle,
  action,
  children,
  className = '',
  padded = true,
  hoverable = false,
}){
  return (
    <section
      className={[
        'bg-bg2 border border-border rounded-lg shadow-card',
        hoverable && 'transition-shadow hover:shadow-cardHover hover:border-border2',
        className,
      ].filter(Boolean).join(' ')}
    >
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-3 border-b border-border/60">
          <div className="min-w-0">
            {title && (
              <h3 className="text-xs uppercase tracking-wider text-text3 font-mono truncate">{title}</h3>
            )}
            {subtitle && (
              <div className="text-text2 text-sm mt-0.5 truncate">{subtitle}</div>
            )}
          </div>
          {action && <div className="shrink-0 flex items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}
