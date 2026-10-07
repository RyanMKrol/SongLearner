// Keeps everything the app remembers (songs you're learning, lyrics and your edits to them,
// sections, progress, reading fixes, settings) in plain JSON files under data/, so nothing
// depends on the browser's storage.
//
// Layout:
//   data/library.json          songs you've opened, newest first
//   data/settings.json         app settings (volume, practice options, romaji mode...)
//   data/songs/<trackId>.json  per song: { trackId, name, artists, lyrics, prefs }
//   data/other.json            anything else
//   data/backups/...           a timestamped copy of a file before it's overwritten (at most hourly)
//
// The browser loads everything once at startup (GET /api/store) and sends changes as they happen
// (POST /api/store with { set: { key: value }, remove: [key] }).
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join, relative } from 'node:path'
import type { Plugin } from 'vite'
import { serverLog } from './logSink.ts'

const DATA_DIR = join(process.cwd(), 'data')
const SONGS_DIR = join(DATA_DIR, 'songs')
const BACKUP_DIR = join(DATA_DIR, 'backups')
const BACKUP_EVERY_MS = 60 * 60 * 1000
const MAX_BODY_BYTES = 20 * 1024 * 1024

type Json = unknown
interface SongFile {
  trackId: string
  name?: string
  artists?: string[]
  lyrics?: Json
  prefs?: Json
}

/** Everything in memory, keyed the way the browser keys it. */
let store: Map<string, Json> | null = null
const lastBackup = new Map<string, number>()
let writeQueue: Promise<unknown> = Promise.resolve()

const safeName = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_')

function readJson(path: string): Json | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    if (existsSync(path)) serverLog('store', 'could not read file', { path: relative(process.cwd(), path), error: String(e) }, 'error')
    return undefined
  }
}

function load(): Map<string, Json> {
  if (store) return store
  store = new Map()
  mkdirSync(SONGS_DIR, { recursive: true })
  const library = readJson(join(DATA_DIR, 'library.json'))
  if (library !== undefined) store.set('library', library)
  const settings = readJson(join(DATA_DIR, 'settings.json')) as Record<string, Json> | undefined
  for (const [k, v] of Object.entries(settings ?? {})) store.set(`setting:${k}`, v)
  const other = readJson(join(DATA_DIR, 'other.json')) as Record<string, Json> | undefined
  for (const [k, v] of Object.entries(other ?? {})) store.set(k, v)
  for (const file of readdirSync(SONGS_DIR).filter((f) => f.endsWith('.json'))) {
    const song = readJson(join(SONGS_DIR, file)) as SongFile | undefined
    if (!song?.trackId) continue
    if (song.lyrics !== undefined) store.set(`lyrics:${song.trackId}`, song.lyrics)
    if (song.prefs !== undefined) store.set(`prefs:${song.trackId}`, song.prefs)
  }
  serverLog('store', 'loaded from disk', { keys: store.size, dir: relative(process.cwd(), DATA_DIR) })
  return store
}

/** Which file a key lives in. */
function fileFor(key: string): string {
  if (key === 'library') return join(DATA_DIR, 'library.json')
  if (key.startsWith('setting:')) return join(DATA_DIR, 'settings.json')
  const song = /^(prefs|lyrics):(.+)$/.exec(key)
  if (song) return join(SONGS_DIR, `${safeName(song[2])}.json`)
  return join(DATA_DIR, 'other.json')
}

/** The full contents of one file, built from the in-memory store. */
function contentsOf(path: string, data: Map<string, Json>): Json | undefined {
  if (path === join(DATA_DIR, 'library.json')) return data.get('library')
  if (path === join(DATA_DIR, 'settings.json')) {
    const out: Record<string, Json> = {}
    for (const [k, v] of data) if (k.startsWith('setting:')) out[k.slice('setting:'.length)] = v
    return out
  }
  if (path === join(DATA_DIR, 'other.json')) {
    const out: Record<string, Json> = {}
    for (const [k, v] of data) if (fileFor(k) === path) out[k] = v
    return out
  }
  // A song file: find its track id from whichever key maps here.
  for (const k of data.keys()) {
    const m = /^(prefs|lyrics):(.+)$/.exec(k)
    if (m && fileFor(k) === path) {
      const trackId = m[2]
      const entry = (data.get('library') as { id: string; name?: string; artists?: string[] }[] | undefined)?.find(
        (e) => e.id === trackId,
      )
      const song: SongFile = {
        trackId,
        // Name and artists are only here to make the file easy to recognise.
        name: entry?.name,
        artists: entry?.artists,
        lyrics: data.get(`lyrics:${trackId}`),
        prefs: data.get(`prefs:${trackId}`),
      }
      return song
    }
  }
  return undefined
}

async function backup(path: string): Promise<void> {
  if (!existsSync(path)) return
  const now = Date.now()
  if (now - (lastBackup.get(path) ?? 0) < BACKUP_EVERY_MS) return
  lastBackup.set(path, now)
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const target = join(BACKUP_DIR, relative(DATA_DIR, path).replace(/\.json$/, `.${stamp}.json`))
  await mkdir(dirname(target), { recursive: true })
  await copyFile(path, target)
}

/** Writes a file atomically: to a temporary file first, then renamed over the old one. */
async function writeFileSafely(path: string, value: Json): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await backup(path)
  const temp = `${path}.tmp-${process.pid}`
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temp, path)
}

async function apply(set: Record<string, Json>, remove: string[]): Promise<void> {
  const data = load()
  const touched = new Set<string>()
  for (const [k, v] of Object.entries(set)) {
    data.set(k, v)
    touched.add(fileFor(k))
  }
  for (const k of remove) {
    data.delete(k)
    touched.add(fileFor(k))
  }
  // A song's file shows its name from the library, so refresh song files when the library changes.
  if ('library' in set) {
    for (const k of data.keys()) if (/^(prefs|lyrics):/.test(k)) touched.add(fileFor(k))
  }
  writeQueue = writeQueue.then(async () => {
    for (const path of touched) {
      const contents = contentsOf(path, data)
      if (contents !== undefined) {
        await writeFileSafely(path, contents)
      } else if (path.startsWith(SONGS_DIR) && existsSync(path)) {
        // Every key for this song is gone (it was deleted): keep a last copy, then remove the file.
        lastBackup.delete(path)
        await backup(path)
        await unlink(path)
        serverLog('store', 'deleted song file', { file: relative(process.cwd(), path) })
      }
    }
  })
  await writeQueue
  serverLog('store', 'saved', {
    set: Object.keys(set),
    removed: remove,
    files: [...touched].map((p) => relative(process.cwd(), p)),
  })
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('store update too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(Object.fromEntries(load())))
      return
    }
    if (req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { set?: Record<string, Json>; remove?: string[] }
      await apply(body.set ?? {}, Array.isArray(body.remove) ? body.remove : [])
      res.statusCode = 204
      res.end()
      return
    }
    res.statusCode = 405
    res.end()
  } catch (e) {
    serverLog('store', 'request failed', { method: req.method, error: e instanceof Error ? e.message : String(e) }, 'error')
    res.statusCode = 500
    res.end(e instanceof Error ? e.message : 'store error')
  }
}

/** Adds GET/POST /api/store to the dev and preview servers. */
export function diskStorePlugin(): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url !== '/api/store') return next()
    void handle(req, res)
  }
  return {
    name: 'songlearner-disk-store',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}
