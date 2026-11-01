// Dev-server endpoints for the karaoke fill: works out when each word is sung by running
// aligner/align.py (vocal separation + forced alignment) on a copy of the song's audio.
//
// Spotify's stream is encrypted, so the audio comes from YouTube (found automatically, or from a
// link you paste) or from a file you upload. It's kept in data/audio/ so aligning again is quick:
//   data/audio/<trackId>.<ext>        the audio
//   data/audio/<trackId>.vocals.npy   the separated vocals (the slow step), reused next time
//   data/audio/<trackId>.json         where the audio came from
//   data/audio/<trackId>.job.json     how the last job ended, with its word timings if it worked
//
// Jobs run one at a time (each loads about 1.5GB of models and keeps the CPU busy); others wait in
// a queue. A finished job is written to disk straight away, so its timings are there the next time
// the song is opened, even after a restart. The queue is saved too (data/audio/queue.json): after a
// restart, queued jobs and one that was cut off part way are started again.
//
//   GET    /api/align/status          is the Python side installed?
//   GET    /api/align/jobs            every song's job: the queue, the running one and past ones
//   GET    /api/align/<trackId>       the audio's source and the current or last job
//   POST   /api/align/<trackId>/run   queue a job (JSON: AlignRunRequest)
//   POST   /api/align/<trackId>/cancel  stop a queued or running job
//   POST   /api/align/<trackId>/upload  use the uploaded file (raw body, X-File-Name header)
//   DELETE /api/align/<trackId>       forget the audio and the last job
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import type { Plugin } from 'vite'
import { serverLog } from './logSink.ts'

const ALIGNER_DIR = join(process.cwd(), 'aligner')
const PYTHON = join(ALIGNER_DIR, '.venv', 'bin', 'python')
const SCRIPT = join(ALIGNER_DIR, 'align.py')
const AUDIO_DIR = join(process.cwd(), 'data', 'audio')
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus', '.webm', '.mp4'])

export interface AlignLine {
  index: number
  startMs: number
  endMs: number
  words: string[]
}

export interface AlignRunRequest {
  artist: string
  title: string
  durationMs: number
  lines: AlignLine[]
  /** Download from this YouTube link first, replacing any audio already there. */
  youtubeUrl?: string
  /** Started by the app on its own rather than by a click (for the logs). */
  auto?: boolean
}

export interface AudioSource {
  kind: 'youtube' | 'upload'
  title: string
  channel?: string
  url?: string
  durationMs?: number
}

export interface AlignJob {
  title?: string
  artist?: string
  auto?: boolean
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  stage: string
  message: string
  pct: number | null
  /** When the job was queued. */
  startedAt: number
  finishedAt?: number
  error?: { kind: string; message: string }
  result?: unknown
  /** The words that were aligned, line by line, so the result can be matched up later. */
  sent?: { index: number; words: string[] }[]
  /** What happened, step by step, for the alignments page. */
  log?: { t: number; message: string }[]
}

interface QueueState {
  /** Jobs since the server started, by track. Older ones are read from data/audio/<trackId>.job.json. */
  jobs: Map<string, AlignJob>
  queue: { id: string; body: AlignRunRequest }[]
  current: { id: string; body: AlignRunRequest; child: ChildProcess | null } | null
  /** Whether the saved queue has been picked up since the process started. */
  resumed: boolean
}

// Vite reloads this module whenever its config or this file changes, but keeps the same process.
// Keeping the queue on globalThis means a reload carries on with the same queue instead of starting
// a second one beside it.
const globalState = globalThis as typeof globalThis & { __songlearnerAlign?: QueueState }
const state: QueueState = (globalState.__songlearnerAlign ??= { jobs: new Map(), queue: [], current: null, resumed: false })
const jobs = state.jobs
const queue = state.queue
const MAX_LOG = 200

// When the dev server exits, stop the running job too; the saved queue starts it again next time.
if (!(globalState as { __songlearnerAlignExitHook?: boolean }).__songlearnerAlignExitHook) {
  ;(globalState as { __songlearnerAlignExitHook?: boolean }).__songlearnerAlignExitHook = true
  process.once('exit', () => state.current?.child?.kill('SIGTERM'))
}
const safeId = (id: string) => /^[A-Za-z0-9]+$/.test(id)
const base = (id: string) => join(AUDIO_DIR, id)
const metaPath = (id: string) => `${base(id)}.json`
const vocalsPath = (id: string) => `${base(id)}.vocals.npy`
const jobPath = (id: string) => `${base(id)}.job.json`
const QUEUE_PATH = join(AUDIO_DIR, 'queue.json')

/** Notes a step in a job's log. */
function note(job: AlignJob, message: string): void {
  const log = (job.log ??= [])
  if (log.at(-1)?.message === message) return
  log.push({ t: Date.now(), message })
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG)
}

/** Saves what's queued (and what's running, so a restart picks it up again). */
function saveQueue(): void {
  const pending = [...(state.current ? [state.current] : []), ...queue].map(({ id, body }) => ({ id, body }))
  try {
    mkdirSync(AUDIO_DIR, { recursive: true })
    writeFileSync(QUEUE_PATH, JSON.stringify(pending))
  } catch (e) {
    serverLog('align', 'could not save the queue', { error: e instanceof Error ? e.message : String(e) }, 'error')
  }
}

/** Queues a job (or re-queues one after a restart). */
function enqueue(id: string, body: AlignRunRequest, message = 'Waiting for other songs to finish'): void {
  const job: AlignJob = {
    title: body.title,
    artist: body.artist,
    auto: body.auto,
    state: 'queued',
    stage: 'queued',
    message,
    pct: null,
    startedAt: Date.now(),
    sent: body.lines.map((l) => ({ index: l.index, words: l.words })),
  }
  note(job, body.auto ? 'Queued automatically' : 'Queued')
  if (message !== 'Waiting for other songs to finish') note(job, message)
  jobs.set(id, job)
  queue.push({ id, body })
  saveQueue()
}

function audioFile(id: string): string | null {
  if (!existsSync(AUDIO_DIR)) return null
  const name = readdirSync(AUDIO_DIR).find((f) => f.startsWith(`${id}.`) && AUDIO_EXTENSIONS.has(extname(f)))
  return name ? join(AUDIO_DIR, name) : null
}

function readSource(id: string): AudioSource | null {
  try {
    return JSON.parse(readFileSync(metaPath(id), 'utf8')) as AudioSource
  } catch {
    return null
  }
}

function readJob(id: string): AlignJob | null {
  const live = jobs.get(id)
  if (live) return live
  try {
    return JSON.parse(readFileSync(jobPath(id), 'utf8')) as AlignJob
  } catch {
    return null
  }
}

/** Every job, newest first, with the queue in order at the top. Results are summarised, not sent whole. */
function listJobs() {
  const ids = new Set<string>(jobs.keys())
  if (existsSync(AUDIO_DIR)) {
    for (const f of readdirSync(AUDIO_DIR)) if (f.endsWith('.job.json')) ids.add(f.slice(0, -'.job.json'.length))
  }
  const rows = [...ids].flatMap((id) => {
    const job = readJob(id)
    if (!job) return []
    const result = job.result as { offsetMs?: number; lines?: Record<string, unknown>; medianLineShiftMs?: number | null } | undefined
    return [
      {
        trackId: id,
        title: job.title,
        artist: job.artist,
        auto: job.auto,
        state: job.state,
        stage: job.stage,
        message: job.message,
        pct: job.pct,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        error: job.error,
        ahead: job.state === 'queued' ? jobsAhead(id) : 0,
        source: audioFile(id) ? readSource(id) : null,
        linesSent: job.sent?.length,
        linesTimed: result?.lines ? Object.keys(result.lines).length : undefined,
        offsetMs: result?.offsetMs,
        medianLineShiftMs: result?.medianLineShiftMs,
        log: job.log ?? [],
      },
    ]
  })
  const order = (r: (typeof rows)[number]) =>
    r.state === 'running' ? -2 : r.state === 'queued' ? -1 + r.ahead / 1000 : 0
  return rows.sort((a, b) => order(a) - order(b) || b.startedAt - a.startedAt)
}

/** How many jobs will run before this queued one. */
function jobsAhead(id: string): number {
  const place = queue.findIndex((q) => q.id === id)
  return place < 0 ? 0 : place + (state.current ? 1 : 0)
}

/** Removes the audio, the separated vocals and the source note. */
async function forgetAudio(id: string): Promise<void> {
  const paths = [audioFile(id), vocalsPath(id), metaPath(id)].filter((p): p is string => p !== null && existsSync(p))
  await Promise.all(paths.map((p) => unlink(p)))
}

/** Stops a queued or running job. Returns false if there wasn't one. */
function cancel(id: string): boolean {
  const queued = queue.findIndex((q) => q.id === id)
  if (queued >= 0) {
    queue.splice(queued, 1)
    saveQueue()
    void finish(id, { state: 'cancelled', message: 'Cancelled' })
    return true
  }
  if (state.current?.id === id) {
    const job = jobs.get(id)
    if (job) job.state = 'cancelled'
    state.current.child?.kill('SIGTERM')
    return true
  }
  return false
}

/** Ends a job and writes how it went to disk. */
async function finish(id: string, change: Partial<AlignJob>): Promise<void> {
  const job = jobs.get(id)
  if (!job) return
  Object.assign(job, change, { finishedAt: Date.now() })
  note(job, change.state === 'done' ? 'Finished' : change.state === 'cancelled' ? 'Cancelled' : `Failed: ${change.error?.message ?? ''}`)
  mkdirSync(AUDIO_DIR, { recursive: true })
  await writeFile(jobPath(id), JSON.stringify(job))
}

/** Starts the next queued job if nothing is running. */
function pump(): void {
  if (state.current) return
  const next = queue.shift()
  if (!next) return
  state.current = { id: next.id, body: next.body, child: null }
  saveQueue()
  void runJob(next.id, next.body).finally(() => {
    state.current = null
    saveQueue()
    pump()
  })
}

/** Runs align.py, reporting its progress lines to `onProgress`. Resolves with its final "done" result. */
function runScript(
  id: string,
  args: string[],
  input: string | null,
  onProgress: (p: Partial<AlignJob>) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (jobs.get(id)?.state === 'cancelled') return reject(Object.assign(new Error('Cancelled'), { kind: 'cancelled' }))
    const child = spawn(PYTHON, [SCRIPT, ...args], { cwd: ALIGNER_DIR, env: { ...process.env, PYTHONUNBUFFERED: '1' } })
    if (state.current?.id === id) state.current.child = child
    let result: unknown = undefined
    let error: { kind: string; message: string } | null = null
    let stderr = ''
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        // Libraries print the odd notice or progress bar, sometimes on the same line as a message.
        const at = line.indexOf('{"event"')
        if (at < 0) continue
        try {
          const msg = JSON.parse(line.slice(at)) as { event: string; [k: string]: unknown }
          if (msg.event === 'progress') {
            onProgress({ stage: String(msg.stage), message: String(msg.message), pct: (msg.pct as number | null) ?? null })
          } else if (msg.event === 'done') {
            result = msg.result
          } else if (msg.event === 'error') {
            error = { kind: String(msg.kind ?? 'failed'), message: String(msg.message) }
          }
        } catch {
          // Not one of ours.
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000)
    })
    child.on('error', (e) => reject(Object.assign(new Error(e.message), { kind: 'failed' })))
    if (input !== null) child.stdin.end(input)
    else child.stdin.end()
    child.on('close', (code) => {
      if (state.current?.id === id) state.current.child = null
      if (jobs.get(id)?.state === 'cancelled') return reject(Object.assign(new Error('Cancelled'), { kind: 'cancelled' }))
      if (error) return reject(Object.assign(new Error(error.message), { kind: error.kind, stderr }))
      if (code !== 0 || result === undefined) {
        serverLog('align', 'script failed', { args: args[0], code, stderr: stderr.slice(-1500) }, 'error')
        return reject(
          Object.assign(new Error(`The aligner stopped unexpectedly (exit code ${code}).`), { kind: 'failed', stderr }),
        )
      }
      resolve(result)
    })
  })
}

async function runJob(id: string, body: AlignRunRequest): Promise<void> {
  const job = jobs.get(id)
  if (!job) return
  Object.assign(job, { state: 'running', stage: 'start', message: 'Starting' })
  // A late progress message mustn't undo a cancel.
  const update = (p: Partial<AlignJob>) => {
    if (job.state !== 'running') return
    Object.assign(job, p)
    if (p.message) note(job, p.message)
  }
  serverLog('align', 'started', { trackId: id, title: body.title, lines: body.lines.length, youtubeUrl: body.youtubeUrl, auto: body.auto })
  try {
    mkdirSync(AUDIO_DIR, { recursive: true })
    if (body.youtubeUrl || !audioFile(id) || !readSource(id)) {
      await forgetAudio(id)
      const fetchArgs = body.youtubeUrl
        ? ['fetch-url', '--url', body.youtubeUrl, '--out', base(id)]
        : ['fetch', '--artist', body.artist, '--title', body.title, '--duration-ms', String(body.durationMs), '--out', base(id)]
      const fetched = (await runScript(id, fetchArgs, null, update)) as AudioSource & { path: string }
      const source: AudioSource = {
        kind: 'youtube',
        title: fetched.title,
        channel: fetched.channel,
        url: fetched.url,
        durationMs: fetched.durationMs,
      }
      await writeFile(metaPath(id), JSON.stringify(source, null, 2))
      serverLog('align', 'audio downloaded', { trackId: id, ...source })
    }
    const audio = audioFile(id)
    if (!audio) throw Object.assign(new Error('The audio file went missing.'), { kind: 'failed' })
    const request = { audio, vocalsCache: vocalsPath(id), spotifyDurationMs: body.durationMs, lines: body.lines }
    const result = await runScript(id, ['align'], JSON.stringify(request), update)
    await finish(id, { state: 'done', stage: 'done', message: 'Done', pct: 100, result })
    const r = result as { offsetMs: number; lines: Record<string, unknown>; medianLineShiftMs: number | null }
    serverLog('align', 'finished', {
      trackId: id,
      ms: Date.now() - job.startedAt,
      offsetMs: r.offsetMs,
      lines: Object.keys(r.lines).length,
      medianLineShiftMs: r.medianLineShiftMs,
    })
  } catch (e) {
    const kind = (e as { kind?: string }).kind ?? 'failed'
    const message = e instanceof Error ? e.message : String(e)
    // The script's own output (tracebacks, yt-dlp's errors) goes in the job's log for the details view.
    const stderr = (e as { stderr?: string }).stderr
    if (stderr && kind !== 'cancelled') {
      for (const line of stderr.split('\n').filter((l) => l.trim() && !l.includes('UserWarning')).slice(-15)) note(job, `  ${line}`)
    }
    if (kind === 'cancelled' || job.state === 'cancelled') {
      await finish(id, { state: 'cancelled', message: 'Cancelled' })
      serverLog('align', 'cancelled', { trackId: id })
    } else {
      await finish(id, { state: 'failed', error: { kind, message } })
      serverLog('align', 'failed', { trackId: id, kind, message }, 'error')
    }
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error(`Upload too large (over ${Math.round(limit / 1024 / 1024)}MB).`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function isRunRequest(v: unknown): v is AlignRunRequest {
  const r = v as AlignRunRequest
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.title === 'string' &&
    typeof r.artist === 'string' &&
    typeof r.durationMs === 'number' &&
    Array.isArray(r.lines) &&
    r.lines.every((l) => typeof l?.index === 'number' && typeof l.startMs === 'number' && Array.isArray(l.words)) &&
    (r.youtubeUrl === undefined || /^https:\/\/(www\.|music\.|m\.)?(youtube\.com|youtu\.be)\//.test(r.youtubeUrl))
  )
}

async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (path === 'status') {
    return send(res, 200, { installed: existsSync(PYTHON) && existsSync(SCRIPT) })
  }
  if (path === 'jobs' && req.method === 'GET') {
    return send(res, 200, { jobs: listJobs() })
  }
  const [id, action] = path.split('/')
  if (!safeId(id)) return send(res, 400, { error: 'bad_request', message: 'Bad track id.' })

  if (req.method === 'GET' && !action) {
    const job = readJob(id)
    return send(res, 200, {
      source: audioFile(id) ? readSource(id) : null,
      job: job && { ...job, ahead: job.state === 'queued' ? jobsAhead(id) : 0 },
    })
  }
  if (req.method === 'DELETE' && !action) {
    cancel(id)
    jobs.delete(id)
    await forgetAudio(id)
    if (existsSync(jobPath(id))) await unlink(jobPath(id))
    serverLog('align', 'audio removed', { trackId: id })
    return send(res, 200, { ok: true })
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' })
  if (action === 'cancel') {
    const stopped = cancel(id)
    serverLog('align', 'cancel requested', { trackId: id, stopped })
    return send(res, 200, { job: readJob(id) })
  }
  if (!existsSync(PYTHON)) {
    return send(res, 501, { error: 'not_installed', message: 'Run `npm run aligner:setup` once, then try again.' })
  }
  const state = jobs.get(id)?.state
  if (state === 'queued' || state === 'running') {
    return send(res, 409, { error: 'busy', message: 'This song is already being aligned.' })
  }

  if (action === 'upload') {
    const name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'audio'))
    const ext = extname(name).toLowerCase()
    if (!AUDIO_EXTENSIONS.has(ext)) return send(res, 400, { error: 'bad_file', message: `Can't use ${ext || 'that'} files. Try mp3, m4a, wav or flac.` })
    const data = await readBody(req, MAX_UPLOAD_BYTES)
    mkdirSync(AUDIO_DIR, { recursive: true })
    await forgetAudio(id)
    await writeFile(`${base(id)}${ext}`, data)
    const source: AudioSource = { kind: 'upload', title: name }
    await writeFile(metaPath(id), JSON.stringify(source, null, 2))
    jobs.delete(id)
    serverLog('align', 'audio uploaded', { trackId: id, name, bytes: data.length })
    return send(res, 200, { source })
  }
  if (action === 'run') {
    const body = JSON.parse((await readBody(req, 5 * 1024 * 1024)).toString('utf8')) as unknown
    if (!isRunRequest(body)) return send(res, 400, { error: 'bad_request', message: 'Malformed alignment request.' })
    enqueue(id, body)
    serverLog('align', 'queued', { trackId: id, title: body.title, auto: body.auto, ahead: jobsAhead(id) })
    pump()
    const job = jobs.get(id)
    return send(res, 202, { job: job && { ...job, ahead: job.state === 'queued' ? jobsAhead(id) : 0 } })
  }
  return send(res, 404, { error: 'not_found' })
}

/** After a restart, starts the saved queue again (including a job that was cut off part way). */
function resumeQueue(): void {
  if (state.resumed) return
  state.resumed = true
  let saved: { id: string; body: AlignRunRequest }[] = []
  try {
    saved = JSON.parse(readFileSync(QUEUE_PATH, 'utf8')) as typeof saved
  } catch {
    return
  }
  const pending = saved.filter((q) => safeId(q.id) && isRunRequest(q.body))
  if (pending.length === 0) return
  for (const q of pending) enqueue(q.id, q.body, 'Queued again after the dev server restarted')
  serverLog('align', 'queue resumed after restart', { jobs: pending.map((q) => q.body.title) })
  pump()
}

/** Adds /api/align/... to the dev and preview servers. */
export function wordAlignPlugin(): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const match = /^\/api\/align\/([^?]+)/.exec(req.url ?? '')
    if (!match) return next()
    handle(req, res, match[1]).catch((e: unknown) => {
      serverLog('align', 'request failed', { url: req.url, error: e instanceof Error ? e.message : String(e) }, 'error')
      send(res, 500, { error: 'failed', message: e instanceof Error ? e.message : String(e) })
    })
  }
  return {
    name: 'songlearner-word-align',
    configureServer(server) {
      server.middlewares.use(middleware)
      resumeQueue()
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}
