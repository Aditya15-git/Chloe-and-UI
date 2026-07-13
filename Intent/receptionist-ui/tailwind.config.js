/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50:  '#eef6ff',
          100: '#d9ecff',
          200: '#bcddff',
          300: '#8ec6ff',
          400: '#59a6ff',
          500: '#3385fd',
          600: '#1a63f2',
          700: '#134ddf',
          800: '#163fb5',
          900: '#183990',
          950: '#132557',
        },
        clinic: {
          teal:  '#0d9488',
          navy:  '#1e3a5f',
          light: '#f0f9ff',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}

