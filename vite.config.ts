import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import { diskStorePlugin } from './server/diskStore.ts'
import { logSinkPlugin } from './server/logSink.ts'
import { readingReviewPlugin } from './server/readingReview.ts'

// Spotify rejects "localhost" redirect URIs, so the dev server must be reached via 127.0.0.1.
export default defineConfig(({ mode }) => {
  // Loaded without the VITE_ prefix filter so the key stays on the server and never ships to the browser.
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), logSinkPlugin(), diskStorePlugin(), readingReviewPlugin(env.ANTHROPIC_API_KEY)],
    // logs/ and data/ are written by the app itself; watching them would treat every save as a code change.
    server: { host: '127.0.0.1', port: 5173, strictPort: true, watch: { ignored: ['**/logs/**', '**/data/**'] } },
    preview: { host: '127.0.0.1', port: 5173, strictPort: true },
    test: { environment: 'node' },
  }
})
