// Copies the Japanese dictionary used for romaji into public/, so the browser can download it.
// It's about 17MB, so it's copied from node_modules on demand instead of being committed.
//
// The files are renamed from .dat.gz to .dat.bin. Many servers (Vite's dev server included) send
// .gz files with "Content-Encoding: gzip", so the browser unzips them before kuromoji's loader,
// which then fails trying to unzip them again. src/lyrics/romaji.ts requests the .bin names.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'node_modules', '@sglkc', 'kuromoji', 'dict')
const to = join(root, 'public', 'kuromoji-dict')

if (!existsSync(from)) {
  console.warn('kuromoji dictionary not found; run npm install first. Romaji will be unavailable.')
  process.exit(0)
}
rmSync(to, { recursive: true, force: true })
mkdirSync(to, { recursive: true })
for (const file of readdirSync(from)) {
  if (file.endsWith('.dat.gz')) cpSync(join(from, file), join(to, file.replace(/\.dat\.gz$/, '.dat.bin')))
}
