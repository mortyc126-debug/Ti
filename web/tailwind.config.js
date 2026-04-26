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
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'monospace'],
      },
    },
  },
  plugins: [],
};
