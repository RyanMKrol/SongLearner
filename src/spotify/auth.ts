// Spotify login using the Authorization Code flow with PKCE.
// Everything runs in the browser, so no client secret is involved.
import { log, logError, logWarn } from '../log'

const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID as string | undefined
const AUTH_URL = 'https://accounts.spotify.com/authorize'
const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
]

const TOKEN_KEY = 'songlearner:token'
const VERIFIER_KEY = 'songlearner:pkce-verifier'
const STATE_KEY = 'songlearner:pkce-state'

interface StoredToken {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
}

export function hasClientId(): boolean {
  return Boolean(CLIENT_ID)
}

export function redirectUri(): string {
  return `${window.location.origin}/callback`
}

function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => chars[b % chars.length]).join('')
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function readToken(): StoredToken | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY)
    return raw ? (JSON.parse(raw) as StoredToken) : null
  } catch {
    return null
  }
}

function saveToken(res: TokenResponse, previousRefresh?: string): StoredToken {
  const token: StoredToken = {
    accessToken: res.access_token,
    // Spotify doesn't always send a new refresh token, so keep the old one.
    refreshToken: res.refresh_token ?? previousRefresh ?? '',
    expiresAt: Date.now() + res.expires_in * 1000,
  }
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token))
  return token
}

export function isLoggedIn(): boolean {
  return readToken() !== null
}

export async function login(): Promise<void> {
  if (!CLIENT_ID) throw new Error('VITE_SPOTIFY_CLIENT_ID is not set')
  const verifier = randomString(64)
  const state = randomString(16)
  localStorage.setItem(VERIFIER_KEY, verifier)
  localStorage.setItem(STATE_KEY, state)
  log('auth', 'redirecting to Spotify login', { redirectUri: redirectUri(), scopes: SCOPES })

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: await codeChallenge(verifier),
    scope: SCOPES.join(' '),
    state,
  })
  window.location.assign(`${AUTH_URL}?${params}`)
}

export function logout(): void {
  log('auth', 'logged out')
  localStorage.removeItem(TOKEN_KEY)
}

async function requestToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Spotify token request failed (${res.status}): ${text}`)
  }
  return (await res.json()) as TokenResponse
}

/**
 * If the current URL is the OAuth callback, swap the code for tokens and clean up the URL.
 * Returns an error message if the callback failed, or null otherwise.
 */
let callbackResult: Promise<string | null> | null = null

export function handleCallback(): Promise<string | null> {
  // React StrictMode runs effects twice in development; the code can only be exchanged once.
  callbackResult ??= exchangeCallbackCode()
  return callbackResult
}

async function exchangeCallbackCode(): Promise<string | null> {
  if (window.location.pathname !== '/callback') return null
  const params = new URLSearchParams(window.location.search)
  window.history.replaceState(null, '', '/')

  const error = params.get('error')
  if (error) {
    logWarn('auth', 'login cancelled or failed', { error })
    return `Spotify login was cancelled or failed: ${error}`
  }

  const code = params.get('code')
  const verifier = localStorage.getItem(VERIFIER_KEY)
  const expectedState = localStorage.getItem(STATE_KEY)
  localStorage.removeItem(VERIFIER_KEY)
  localStorage.removeItem(STATE_KEY)

  if (!code || !verifier) return 'Spotify login could not be completed. Please try again.'
  if (params.get('state') !== expectedState) return 'Spotify login state did not match. Please try again.'

  try {
    const res = await requestToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: CLIENT_ID ?? '',
      code_verifier: verifier,
    })
    const token = saveToken(res)
    log('auth', 'logged in', { expiresAt: new Date(token.expiresAt).toISOString(), gotRefreshToken: Boolean(res.refresh_token) })
    return null
  } catch (e) {
    logError('auth', 'code exchange failed', { error: e })
    return e instanceof Error ? e.message : String(e)
  }
}

let refreshing: Promise<StoredToken> | null = null

async function refresh(token: StoredToken): Promise<StoredToken> {
  // Several callers may notice an expired token at once; only refresh once.
  if (!refreshing) log('auth', 'refreshing access token', { expiredAt: new Date(token.expiresAt).toISOString() })
  refreshing ??= requestToken({
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
    client_id: CLIENT_ID ?? '',
  })
    .then((res) => {
      const saved = saveToken(res, token.refreshToken)
      log('auth', 'token refreshed', { expiresAt: new Date(saved.expiresAt).toISOString(), newRefreshToken: Boolean(res.refresh_token) })
      return saved
    })
    .finally(() => {
      refreshing = null
    })
  return refreshing
}

export class AuthError extends Error {}

/** Fired on window when the session can't be refreshed and the user has to log in again. */
export const AUTH_LOST_EVENT = 'songlearner:auth-lost'

/** Returns a valid access token, refreshing it first if it's about to expire. */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  const token = readToken()
  if (!token) throw new AuthError('Not logged in')
  if (!forceRefresh && token.expiresAt - Date.now() > 60_000) return token.accessToken
  try {
    return (await refresh(token)).accessToken
  } catch (e) {
    logError('auth', 'refresh failed; session lost', { error: e })
    logout()
    window.dispatchEvent(new Event(AUTH_LOST_EVENT))
    throw new AuthError(e instanceof Error ? e.message : String(e))
  }
}
