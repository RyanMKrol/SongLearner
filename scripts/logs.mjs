// Prints the diagnostic logs (logs/<date>.jsonl) as a readable timeline.
//
//   npm run logs                    latest browser session, today
//   npm run logs -- --sessions      list today's sessions
//   npm run logs -- --session ab12  one session
//   npm run logs -- --scope test,player --level warn --date 2026-10-07 --all
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const option = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const dir = join(process.cwd(), 'logs')
if (!existsSync(dir)) {
  console.log('No logs yet. They appear in logs/ once the app has run with the dev server.')
  process.exit(0)
}
const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
const file = option('date') ? `${option('date')}.jsonl` : files.at(-1)
if (!file || !existsSync(join(dir, file))) {
  console.log(`No log file for ${option('date') ?? 'today'}. Available: ${files.join(', ')}`)
  process.exit(0)
}

const rows = readFileSync(join(dir, file), 'utf8')
  .split('\n')
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })

const sessions = new Map()
for (const r of rows) {
  if (r.source !== 'browser') continue
  const s = sessions.get(r.session) ?? { id: r.session, first: r.t, last: r.t, count: 0, url: '' }
  s.last = r.t
  s.count++
  if (r.event === 'loaded') s.url = r.data?.url ?? ''
  sessions.set(r.session, s)
}

if (flag('sessions')) {
  for (const s of sessions.values()) {
    const local = (t) => new Date(t).toLocaleTimeString('en-GB', { hour12: false })
    console.log(`${s.id}  ${local(s.first)}-${local(s.last)}  ${String(s.count).padStart(6)} entries  ${s.url}`)
  }
  process.exit(0)
}

const levels = ['debug', 'info', 'warn', 'error']
const minLevel = levels.indexOf(option('level') ?? 'debug')
const scopes = option('scope')?.split(',')
const sessionId = option('session') ?? (flag('all') ? null : [...sessions.values()].at(-1)?.id)

for (const r of rows) {
  if (sessionId && r.session !== sessionId && r.source !== 'server') continue
  if (sessionId && r.source === 'server' && !flag('server')) continue
  if (levels.indexOf(r.level ?? 'info') < minLevel) continue
  if (scopes && !scopes.includes(r.scope)) continue
  const d = new Date(r.t)
  const time = `${d.toLocaleTimeString('en-GB', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
  const level = r.level === 'error' ? 'ERR ' : r.level === 'warn' ? 'WARN' : r.level === 'debug' ? '    ' : 'INFO'
  const data = r.data ? JSON.stringify(r.data) : ''
  console.log(`${time} ${level} ${r.scope.padEnd(11)} ${r.event}${data ? '  ' + (data.length > 220 ? data.slice(0, 220) + '…' : data) : ''}`)
}
