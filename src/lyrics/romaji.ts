// Turns Japanese lyric lines (kanji, hiragana, katakana) into romaji you can sing from.
// kuromoji splits each line into words and supplies the reading of every kanji word; wanakana
// then spells the readings out in Latin letters.
import * as kuromojiModule from '@sglkc/kuromoji'
import type { IpadicFeatures, Tokenizer } from '@sglkc/kuromoji'
import { toRomaji } from 'wanakana'

const JAPANESE = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ々〆ヵヶ]/

export function hasJapanese(text: string): boolean {
  return JAPANESE.test(text)
}

interface Piece {
  kind: 'word' | 'punct' | 'space'
  text: string
  /** Kana still to be converted (words only). Kept separate so glued parts convert together. */
  kana: boolean
  token?: IpadicFeatures
}

const isVerbLike = (t?: IpadicFeatures) =>
  t !== undefined && (t.pos === '動詞' || t.pos === '形容詞' || t.pos === '助動詞')

/**
 * Should this token be glued onto the word before it? Verb and adjective endings read better
 * attached ("ikitai", "kaeranaide") while particles stay as separate words.
 */
function attachesToPrevious(token: IpadicFeatures, prev?: IpadicFeatures): boolean {
  if (!prev) return false
  const { pos, pos_detail_1: detail, surface_form: surface } = token
  // Endings like たい, ない, た, う after a verb, adjective or another ending.
  if (pos === '助動詞') return isVerbLike(prev)
  // て/で/ば joining a verb to what follows: 飲んで, 待って.
  if (pos === '助詞' && detail === '接続助詞' && ['て', 'で', 'ば'].includes(surface)) return isVerbLike(prev)
  // Helper verbs straight after a verb (待ってる) or passive/causative suffixes (れる, せる).
  if (pos === '動詞' && (detail === '非自立' || detail === '接尾')) return prev.pos === '動詞'
  if (pos === '形容詞' && (detail === '非自立' || detail === '接尾')) return prev.pos === '動詞'
  // Suffixes on nouns: 私たち, 田中さん.
  if (pos === '名詞' && detail === '接尾') return prev.pos === '名詞'
  return false
}

/** Particles are written the way they're pronounced. */
function particleRomaji(token: IpadicFeatures): string | null {
  if (token.pos !== '助詞') return null
  if (token.surface_form === 'は' && token.pos_detail_1 === '係助詞') return 'wa'
  if (token.surface_form === 'へ' && token.pos_detail_1 === '格助詞') return 'e'
  if (token.surface_form === 'を') return 'o'
  return null
}

const DROPPED = /[「」『』【】〈〉《》]/g
const OPENING = new Set(['(', '['])

function readingOf(token: IpadicFeatures): string {
  const reading = token.reading
  return reading && reading !== '*' ? reading : token.surface_form
}

/** Romaji for one tokenised line. Exported for tests; the app uses `romanizeLines`. */
export function romanizeTokens(tokens: IpadicFeatures[]): string {
  const pieces: Piece[] = []
  for (const token of tokens) {
    const surface = token.surface_form.replace(DROPPED, '')
    if (!surface) continue
    const last = pieces.at(-1)

    if (/^\s+$/u.test(surface) || surface === '・') {
      pieces.push({ kind: 'space', text: ' ', kana: false })
      continue
    }
    if (token.pos === '記号' || !/[\p{L}\p{N}]/u.test(surface)) {
      pieces.push({ kind: 'punct', text: toRomaji(surface), kana: false })
      continue
    }
    if (!hasJapanese(surface)) {
      // English words and numbers stay as they are.
      pieces.push({ kind: 'word', text: surface, kana: false, token })
      continue
    }

    const particle = particleRomaji(token)
    if (particle) {
      pieces.push({ kind: 'word', text: particle, kana: false, token })
      continue
    }

    const reading = readingOf(token)
    if (last?.kind === 'word' && last.kana && attachesToPrevious(token, last.token)) {
      last.text += reading
      last.token = token
    } else {
      pieces.push({ kind: 'word', text: reading, kana: true, token })
    }
  }

  let out = ''
  let previous: Piece | undefined
  for (const piece of pieces) {
    const text = piece.kana ? toRomaji(piece.text) : piece.text
    if (piece.kind === 'space') {
      if (out && !out.endsWith(' ')) out += ' '
    } else if (piece.kind === 'punct') {
      out = out.trimEnd() + text
    } else {
      const needsSpace =
        out.length > 0 && !out.endsWith(' ') && !(previous?.kind === 'punct' && OPENING.has(previous.text))
      out += (needsSpace ? ' ' : '') + text
    }
    previous = piece
  }
  return out.replace(/\s+/g, ' ').trim()
}

let tokenizerPromise: Promise<Tokenizer<IpadicFeatures>> | null = null

// The package is CommonJS; depending on the bundler its API is on the namespace or on `default`.
const kuromoji = ((kuromojiModule as unknown as { default?: typeof kuromojiModule }).default ??
  kuromojiModule) as typeof kuromojiModule

let fetchPatched = false

/**
 * kuromoji always requests "<name>.dat.gz", but servers tend to send .gz files with
 * "Content-Encoding: gzip", so the browser unzips them and kuromoji's own unzip then fails.
 * The files are published as .dat.bin instead (see scripts/copy-kuromoji-dict.mjs), and this
 * points kuromoji's requests at those names.
 */
function redirectDictionaryRequests(dicPath: string): void {
  if (fetchPatched || typeof window === 'undefined') return
  fetchPatched = true
  const originalFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith(dicPath) && input.endsWith('.dat.gz')) {
      return originalFetch(input.replace(/\.dat\.gz$/, '.dat.bin'), init)
    }
    return originalFetch(input, init)
  }
}

/** Loads the tokenizer and its ~17MB dictionary once, on first use. */
export function loadTokenizer(dicPath = `${import.meta.env.BASE_URL}kuromoji-dict/`) {
  redirectDictionaryRequests(dicPath)
  tokenizerPromise ??= new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath }).build((err, tokenizer) => {
      if (err) {
        tokenizerPromise = null
        reject(err instanceof Error ? err : new Error(String(err)))
      } else {
        resolve(tokenizer)
      }
    })
  })
  return tokenizerPromise
}

/** Romaji for each line, or null for lines with no Japanese in them. */
export async function romanizeLines(texts: string[]): Promise<(string | null)[]> {
  if (!texts.some(hasJapanese)) return texts.map(() => null)
  const tokenizer = await loadTokenizer()
  return texts.map((text) => (hasJapanese(text) ? romanizeTokens(tokenizer.tokenize(text)) : null))
}
