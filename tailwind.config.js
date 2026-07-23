/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Semantic, theme-aware tokens (RGB triplets in index.css → opacity modifiers work)
        base:           'rgb(var(--bg) / <alpha-value>)',
        surface:        'rgb(var(--surface) / <alpha-value>)',
        'surface-2':    'rgb(var(--surface-2) / <alpha-value>)',
        'surface-3':    'rgb(var(--surface-3) / <alpha-value>)',
        line:           'rgb(var(--line) / <alpha-value>)',
        fg:             'rgb(var(--fg) / <alpha-value>)',
        muted:          'rgb(var(--muted) / <alpha-value>)',
        faint:          'rgb(var(--faint) / <alpha-value>)',
        accent:         'rgb(var(--accent) / <alpha-value>)',
        'accent-strong':'rgb(var(--accent-strong) / <alpha-value>)',
      },
      fontFamily: {
        display: ['"Advent Pro"', 'system-ui', 'sans-serif'],
        body: ['"Advent Pro"', 'system-ui', 'sans-serif'],
        sans: ['"Advent Pro"', 'system-ui', 'sans-serif'],
        mono: ['"Advent Pro"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
