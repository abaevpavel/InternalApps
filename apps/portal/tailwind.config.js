/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          dark: '#111417',   // тёмный хедер
          amber: '#f0ad3c',  // акцент (кнопки)
          blue: '#3b82f6',
        },
        accent: {
          50: '#fdf6ec',
          100: '#f8e7cd',
          500: '#c87a2c',
          600: '#b45309',
          700: '#92400e',
        },
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(16 24 40 / 0.04)',
      },
    },
  },
  plugins: [],
}
