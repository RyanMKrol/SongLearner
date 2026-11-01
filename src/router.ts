// A tiny router: each screen has its own address, so the browser's back and forward (buttons,
// trackpad swipes, keyboard) move between screens, and a refresh keeps you where you were.
//
//   /                home
//   /song/<trackId>  a song
//   /karaoke         the karaoke set
//   /playlist/<id>   one of your playlists
//   /alignments      progress of the karaoke fill's word alignment, for every song
import { useSyncExternalStore } from 'react'
import { log } from './log'

export type Route =
  | { name: 'home' }
  | { name: 'song'; trackId: string }
  | { name: 'karaoke' }
  | { name: 'playlist'; playlistId: string }
  | { name: 'alignments' }

export function parseRoute(pathname: string): Route {
  const song = /^\/song\/([^/]+)\/?$/.exec(pathname)
  if (song) return { name: 'song', trackId: decodeURIComponent(song[1]) }
  if (/^\/karaoke\/?$/.test(pathname)) return { name: 'karaoke' }
  if (/^\/alignments\/?$/.test(pathname)) return { name: 'alignments' }
  const playlist = /^\/playlist\/([^/]+)\/?$/.exec(pathname)
  if (playlist) return { name: 'playlist', playlistId: decodeURIComponent(playlist[1]) }
  return { name: 'home' }
}

export function routePath(route: Route): string {
  if (route.name === 'song') return `/song/${encodeURIComponent(route.trackId)}`
  if (route.name === 'karaoke') return '/karaoke'
  if (route.name === 'alignments') return '/alignments'
  if (route.name === 'playlist') return `/playlist/${encodeURIComponent(route.playlistId)}`
  return '/'
}

export const songRoute = (trackId: string): Route => ({ name: 'song', trackId })

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    log('nav', 'back/forward', { path: location.pathname })
    notify()
  })
}

/** Go to a screen. `replace` swaps the current history entry instead of adding one. */
export function navigate(route: Route, { replace = false }: { replace?: boolean } = {}): void {
  const path = routePath(route)
  if (path === location.pathname) return
  log('nav', replace ? 'replace' : 'go', { from: location.pathname, to: path })
  if (replace) history.replaceState(null, '', path)
  else history.pushState(null, '', path)
  notify()
}

let cachedPath = ''
let cachedRoute: Route = { name: 'home' }

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => {
      // Return the same object while the path is unchanged, so React doesn't re-render needlessly.
      if (location.pathname !== cachedPath) {
        cachedPath = location.pathname
        cachedRoute = parseRoute(cachedPath)
      }
      return cachedRoute
    },
  )
}
