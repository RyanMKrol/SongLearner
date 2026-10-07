import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Spotify rejects "localhost" redirect URIs, so the dev server must be reached via 127.0.0.1.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
  test: { environment: 'node' },
})
