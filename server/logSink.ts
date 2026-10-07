// Collects the app's diagnostic logs on the dev server and appends them to logs/<date>.jsonl,
// one JSON object per line. The browser batches entries and posts them to /api/logs; the server
// adds its own entries (e.g. Claude reading reviews) through `serverLog`.
import { appendFile, mkdir } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Plugin } from 'vite'

const LOG_DIR = join(process.cwd(), 'logs')
const MAX_BODY_BYTES = 5 * 1024 * 1024

let ready: Promise<unknown> | null = null
let queue: Promise<unknown> = Promise.resolve()

function logFile(date = new Date()): string {
  // Local date, so a day's file matches the user's day.
  const pad = (n: number) => String(n).padStart(2, '0')
  return join(LOG_DIR, `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.jsonl`)
}

/** Appends entries in order. Writes are chained so concurrent posts never interleave lines. */
function write(entries: object[]): Promise<unknown> {
  if (entries.length === 0) return queue
  ready ??= mkdir(LOG_DIR, { recursive: true })
  const text = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  queue = queue
    .then(() => ready)
    .then(() => appendFile(logFile(), text))
    .catch((e) => console.error('[songlearner] could not write logs:', e))
  return queue
}

/** Log from server code (same file and shape as the browser's entries). */
export function serverLog(scope: string, event: string, data?: Record<string, unknown>, level = 'info'): void {
  void write([{ t: new Date().toISOString(), source: 'server', level, scope, event, ...(data ? { data } : {}) }])
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('log batch too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(await readBody(req))
    const entries = Array.isArray(parsed) ? parsed.filter((e) => typeof e === 'object' && e !== null) : []
    const receivedAt = new Date().toISOString()
    await write(entries.map((e) => ({ ...(e as object), source: 'browser', receivedAt })))
    res.statusCode = 204
    res.end()
  } catch (e) {
    res.statusCode = 400
    res.end(e instanceof Error ? e.message : 'bad log batch')
  }
}

/** Adds POST /api/logs to the dev and preview servers. */
export function logSinkPlugin(): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url !== '/api/logs' || req.method !== 'POST') return next()
    void handle(req, res)
  }
  return {
    name: 'songlearner-log-sink',
    configureServer(server) {
      serverLog('server', 'dev server started', { mode: server.config.mode })
      server.middlewares.use(middleware)
      // Record hot updates and reloads, since they can rebuild what's on screen mid-practice.
      server.watcher.on('change', (file) => {
        if (file.startsWith(LOG_DIR)) return
        serverLog('server', 'file changed', { file: file.replace(process.cwd(), '') })
      })
    },
    configurePreviewServer(server) {
      serverLog('server', 'preview server started')
      server.middlewares.use(middleware)
    },
  }
}
