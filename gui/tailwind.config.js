/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/client/**/*.{ts,tsx,html}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#070a13",
          900: "#0b0f1c",
          800: "#11172a",
          700: "#1a2238",
          600: "#283153",
          500: "#3a4570",
        },
        accent: {
          cyan: "#22d3ee",
          violet: "#a78bfa",
          rose: "#fb7185",
          amber: "#fbbf24",
          emerald: "#34d399",
          sky: "#60a5fa",
          fuchsia: "#e879f9",
          orange: "#fb923c",
          lime: "#a3e635",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Menlo", "monospace"],
      },
      animation: {
        "fade-in": "fadeIn .25s ease-out",
        "slide-in": "slideIn .25s cubic-bezier(.2,.9,.3,1)",
        "pulse-slow": "pulse 2.5s cubic-bezier(.4,0,.6,1) infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0", transform: "translateY(2px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        slideIn: {
          "0%": { opacity: "0", transform: "translateX(8px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
      },
    },
  },
  plugins: [],
};
