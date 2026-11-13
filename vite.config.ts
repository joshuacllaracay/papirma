import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// In development, /api and /__dev are served by the local dev backend (npm run dev:api).
const devApi = 'http://localhost:8787'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: devApi, changeOrigin: false },
      '/__dev': { target: devApi, changeOrigin: false },
    },
  },
})
