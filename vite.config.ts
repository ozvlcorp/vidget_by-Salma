import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/moysklad': {
        target: 'https://api.moysklad.ru/api/remap/1.2',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/moysklad/, ''),
        secure: true,
      },
    }
  }
})
