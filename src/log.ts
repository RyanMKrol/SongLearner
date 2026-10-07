// Diagnostic logging. Everything worth knowing about a practice session (player events, API
// calls, loops, test attempts, setting changes, errors, hot reloads) is recorded here, batched,
// and sent to the dev server, which appends it to logs/<date>.jsonl (see server/logSink.ts).
//
// Never log secrets (tokens, keys) or lyric text; log IDs, counts and timings instead.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  t: string
  /** Milliseconds since this page loaded, for precise ordering and timing. */
  ms: number
  session: string
  level: LogLevel
  scope: string
  event: string
  data?: Record<string, unknown>
}

const ENDPOINT = '/api/logs'
const FLUSH_MS = 2000
/** Entries kept in memory (and on window.songlearnerLogs) for inspecting in the console. */
const MEMORY_LIMIT = 5000

const session = (() => {
  try {
    return crypto.randomUUID().slice(0, 8)
  } catch {
    return Math.random().toString(36).slice(2, 10)
  }
})()

const pending: LogEntry[] = []
const recent: LogEntry[] = []
let timer: number | null = null
let sinkAvailable = true

const SECRET_KEY = /^code$|access_?token|refresh_?token|^token$|secret|password|api[-_]?key|authorization|verifier/i

/** Makes data safe and compact for logging: drops secrets, rounds floats, trims long strings. */
function clean(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'number') return Number.isInteger(value) ? value : Math.round(value * 1000) / 1000
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…(${value.length})` : value
  if (typeof value === 'boolean') return value
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 8).join('\n') }
  if (depth > 4) return '[deep]'
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((v) => clean(v, depth + 1))
    return value.length > 50 ? [...items, `…(${value.length} items)`] : items
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : clean(v, depth + 1)
    return out
  }
  return String(value)
}

export function log(scope: string, event: string, data?: Record<string, unknown>, level: LogLevel = 'info'): void {
  const entry: LogEntry = {
    t: new Date().toISOString(),
    ms: Math.round(performance.now()),
    session,
    level,
    scope,
    event,
    ...(data ? { data: clean(data) as Record<string, unknown> } : {}),
  }
  recent.push(entry)
  if (recent.length > MEMORY_LIMIT) recent.splice(0, recent.length - MEMORY_LIMIT)
  if (sinkAvailable) pending.push(entry)
  if (import.meta.env.DEV) {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.debug
    fn(`[${scope}] ${event}`, data ?? '')
  }
  scheduleFlush()
}

export const logWarn = (scope: string, event: string, data?: Record<string, unknown>) => log(scope, event, data, 'warn')
export const logError = (scope: string, event: string, data?: Record<string, unknown>) => log(scope, event, data, 'error')
export const logDebug = (scope: string, event: string, data?: Record<string, unknown>) => log(scope, event, data, 'debug')

function scheduleFlush(): void {
  if (timer !== null || !sinkAvailable) return
  timer = window.setTimeout(() => {
    timer = null
    void flush()
  }, FLUSH_MS)
}

async function flush(): Promise<void> {
  if (pending.length === 0 || !sinkAvailable) return
  const batch = pending.splice(0, pending.length)
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
      keepalive: true,
    })
    // A static host without the dev server: stop sending, keep logging in memory.
    if (res.status === 404 || res.status === 405) sinkAvailable = false
  } catch {
    // Dev server briefly down (e.g. restarting): put the batch back and retry later.
    pending.unshift(...batch)
    scheduleFlush()
  }
}

/** Sends whatever is pending right now, even as the page closes. */
function flushOnExit(): void {
  if (pending.length === 0 || !sinkAvailable) return
  const batch = pending.splice(0, pending.length)
  const blob = new Blob([JSON.stringify(batch)], { type: 'application/json' })
  if (!navigator.sendBeacon?.(ENDPOINT, blob)) pending.unshift(...batch)
}

/** Records page-level events: load, errors, visibility, network, hot reloads. Call once at startup. */
export function initLogging(): void {
  ;(window as unknown as { songlearnerLogs: LogEntry[] }).songlearnerLogs = recent
  log('page', 'loaded', {
    url: location.pathname + location.search.replace(/code=[^&]+/, 'code=[redacted]'),
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    devicePixelRatio: window.devicePixelRatio,
    language: navigator.language,
  })

  window.addEventListener('error', (e) => {
    logError('page', 'uncaught error', { message: e.message, source: e.filename, line: e.lineno, col: e.colno, error: e.error })
  })
  window.addEventListener('unhandledrejection', (e) => {
    logError('page', 'unhandled promise rejection', { reason: e.reason })
  })
  document.addEventListener('visibilitychange', () => log('page', 'visibility', { state: document.visibilityState }))
  window.addEventListener('focus', () => logDebug('page', 'focus'))
  window.addEventListener('blur', () => logDebug('page', 'blur'))
  window.addEventListener('online', () => log('page', 'online'))
  window.addEventListener('offline', () => logWarn('page', 'offline'))
  window.addEventListener('resize', debounce(() => logDebug('page', 'resized', { viewport: `${window.innerWidth}x${window.innerHeight}` }), 500))
  document.addEventListener('fullscreenchange', () => log('page', 'fullscreen', { on: Boolean(document.fullscreenElement) }))
  window.addEventListener('pagehide', () => {
    log('page', 'closing')
    flushOnExit()
  })

  if (import.meta.hot) {
    import.meta.hot.on('vite:beforeUpdate', (payload: { updates: { path: string }[] }) => {
      logWarn('page', 'hot update (code changed while running)', { files: payload.updates.map((u) => u.path) })
    })
    import.meta.hot.on('vite:beforeFullReload', () => {
      logWarn('page', 'full reload (code changed while running)')
      flushOnExit()
    })
    import.meta.hot.on('vite:ws:disconnect', () => logWarn('page', 'lost connection to dev server'))
    import.meta.hot.on('vite:ws:connect', () => log('page', 'connected to dev server'))
  }
}

function debounce(fn: () => void, ms: number): () => void {
  let id: number | null = null
  return () => {
    if (id !== null) window.clearTimeout(id)
    id = window.setTimeout(fn, ms)
  }
}

/** Short description of which top-level fields differ between two objects. */
export function changedKeys(before: object, after: object): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter(
    (k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k]),
  )
}
