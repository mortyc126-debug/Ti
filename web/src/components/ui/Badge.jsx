// Бейдж/чип для статусов. Соответствие тону: neutral/acc/green/warn/danger/purple.

const TONES = {
  neutral: 'bg-s2 text-text2 border-border',
  acc:     'bg-acc-dim text-acc border-acc/30',
  green:   'bg-green/10 text-green border-green/25',
  warn:    'bg-warn/10 text-warn border-warn/25',
  danger:  'bg-danger/10 text-danger border-danger/25',
  purple:  'bg-purple/10 text-purple border-purple/25',
};

export default function Badge({ tone = 'neutral', className = '', children, dot = false }){
  return (
    <span
      className={[
        'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider border',
        TONES[tone],
        className,
      ].filter(Boolean).join(' ')}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse-dot" />}
      {children}
    </span>
  );
}
