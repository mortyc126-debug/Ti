/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // Тёмная палитра в духе текущего SPA — чтобы переход выглядел
      // органично, не «другое приложение».
      colors: {
        bg:       '#0a0e14',
        bg2:      '#11161e',
        s2:       '#1a212c',
        border:   '#222a37',
        border2:  '#2e3847',
        text:     '#e6edf3',
        text2:    '#9ba3b1',
        text3:    '#5e6573',
        acc:      '#00d4ff',
        'acc-dim': '#0a3a4a',
        green:    '#22d3a0',
        warn:     '#f5a623',
        danger:   '#ff4d6d',
        purple:   '#a78bfa',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'monospace'],
        serif: ['ui-serif', 'Georgia', 'serif'],
      },
      boxShadow: {
        // Мягкие тени для карточек и hover-состояний на тёмном фоне.
        glow:    '0 0 0 1px rgba(0,212,255,0.15), 0 4px 24px -8px rgba(0,212,255,0.25)',
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
