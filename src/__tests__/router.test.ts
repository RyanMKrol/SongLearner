import { describe, expect, it } from 'vitest'
import { parseRoute, routePath } from '../router'

describe('routes', () => {
  it('round-trips each screen', () => {
    for (const route of [{ name: 'home' }, { name: 'karaoke' }, { name: 'song', trackId: '4J2oDU9oacz7lJ7H8A8P8v' }] as const) {
      expect(parseRoute(routePath(route))).toEqual(route)
    }
  })

  it('treats unknown paths (like the login callback) as home', () => {
    expect(parseRoute('/callback')).toEqual({ name: 'home' })
    expect(parseRoute('/song/')).toEqual({ name: 'home' })
    expect(parseRoute('/karaoke/')).toEqual({ name: 'karaoke' })
  })
})
