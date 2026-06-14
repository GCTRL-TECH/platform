import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      // Dev-only knob: where `vite dev` forwards /api during local development.
      // This is NOT a user-visible URL — at runtime the UI derives all displayed
      // endpoints from window.location.origin + GET /api/config/public. Change
      // the published ports + FRONTEND_URL in docker-compose/.env for prod.
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
