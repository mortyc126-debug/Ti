/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // Палитра синхронизирована с модулями (analysiscompany.html) —
      // тёмно-фиолетовый фон, магента-акцент, бирюзовый «плюс». Раньше сайт
      // был сине-циановым и выбивался из модулей; теперь единый стиль.
      colors: {
        bg:       '#0B0613',
        bg2:      '#140A24',
        s2:       '#1A1030',
        border:   '#241638',
        border2:  '#3A1F44',
        text:     '#F2F0FF',
        text2:    '#A79BC9',
        text3:    '#6F648F',
        acc:      '#FF006E',
        'acc-dim': 'rgba(255,0,110,0.12)',
        green:    '#52F2C9',
        warn:     '#E8895A',
        danger:   '#FF4D7A',
        purple:   '#AA5AFF',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'monospace'],
        serif: ['ui-serif', 'Georgia', 'serif'],
      },
      boxShadow: {
        // Мягкие тени для карточек и hover-состояний на тёмном фоне.
        glow:    '0 0 0 1px rgba(255,0,110,0.15), 0 4px 24px -8px rgba(255,0,110,0.25)',
        card:    '0 1px 0 rgba(255,255,255,0.02) inset, 0 4px 16px -8px rgba(0,0,0,0.5)',
        cardHover: '0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px -12px rgba(0,0,0,0.7)',
      },
      borderRadius: {
        DEFAULT: '6px',
        md: '8px',
        lg: '10px',
        xl: '14px',
      },
      keyframes: {
        pulseDot: {
          '0%,100%': { opacity: '1' },
          '50%':     { opacity: '0.35' },
        },
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'pulse-dot': 'pulseDot 1.6s ease-in-out infinite',
        'fade-in':   'fadeIn 0.18s ease-out',
      },
    },
  },
  plugins: [],
};
