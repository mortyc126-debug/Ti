// Универсальная кнопка. Полиморфная: as=Link/'a' для ссылок, иначе button.
// variant и size, остальные пропсы пробрасываются.

const VARIANTS = {
  primary:   'bg-acc text-bg hover:bg-acc/90 active:bg-acc/80 shadow-[0_0_0_1px_rgba(0,212,255,0.4)]',
  secondary: 'bg-s2 text-text border border-border hover:border-border2 hover:bg-bg2',
  ghost:     'text-text2 hover:text-text hover:bg-s2',
  danger:    'bg-danger/10 text-danger border border-danger/30 hover:bg-danger/20',
  outline:   'border border-border text-text hover:border-acc hover:text-acc',
};

const SIZES = {
  xs: 'h-6 px-2 text-[11px] gap-1',
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-11 px-5 text-base gap-2',
};

const ICON_SIZE = { xs: 12, sm: 14, md: 16, lg: 18 };

export default function Button({
  as: Component = 'button',
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  icon: Icon,
  iconRight: IconRight,
  loading = false,
  disabled,
  ...rest
}){
  const base = 'inline-flex items-center justify-center font-mono uppercase tracking-wider rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed select-none whitespace-nowrap';
  const cls = [base, VARIANTS[variant], SIZES[size], className].filter(Boolean).join(' ');
  const isButton = Component === 'button';
  const props = isButton
    ? { type: rest.type || 'button', disabled: disabled || loading, ...rest }
    : rest;
  const sz = ICON_SIZE[size];
  return (
    <Component className={cls} {...props}>
      {loading
        ? <span className="inline-block w-3 h-3 rounded-full border-2 border-current border-r-transparent animate-spin" />
        : (Icon && <Icon size={sz} />)}
      {children}
      {IconRight && !loading && <IconRight size={sz} />}
    </Component>
  );
}
