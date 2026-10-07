import { beforeAll, describe, expect, it } from 'vitest'
import { hasJapanese, loadTokenizer, normaliseReading, romanizeTokens, type ReadingFixes } from '../lyrics/romaji'

// Vitest runs from the project root, where Node's loader reads the dictionary straight from disk.
const dicPath = 'node_modules/@sglkc/kuromoji/dict/'
let romaji: (text: string) => string
let romajiLine: (text: string, fixes?: ReadingFixes) => ReturnType<typeof romanizeTokens>

beforeAll(async () => {
  const tokenizer = await loadTokenizer(dicPath)
  romajiLine = (text, fixes) => romanizeTokens(tokenizer.tokenize(text), fixes)
  romaji = (text) => romajiLine(text).text
})

describe('hasJapanese', () => {
  it('spots kanji and kana but not Latin text', () => {
    expect(hasJapanese('学生')).toBe(true)
    expect(hasJapanese('ラブ')).toBe(true)
    expect(hasJapanese('Stay with me')).toBe(false)
  })
})

describe('romanizeTokens', () => {
  it('reads kanji and writes particles as they are pronounced', () => {
    expect(romaji('私は学生です')).toBe('watashi wa gakusei desu')
    expect(romaji('東京へ行きたい')).toBe('toukyou e ikitai')
    expect(romaji('コーヒーを飲んでいるよ')).toBe('koohii o nonde iru yo')
  })

  it('keeps verb endings with their verb', () => {
    expect(romaji('帰らないで、ずっと待ってる！')).toBe('kaeranaide, zutto matteru!')
    expect(romaji('雨が降ってきた')).toBe('ame ga futte kita')
    expect(romaji('君のことが好きだった')).toBe('kimi no koto ga suki datta')
  })

  it('reads counted words as whole words', () => {
    expect(romaji('二人で歩こう')).toBe('futari de arukou')
    expect(romaji('一人きりの夜')).toBe('hitori kiri no yoru')
    expect(romaji('三日後に何度も会った')).toBe('mikkago ni nando mo atta')
    expect(romaji('二十歳の春')).toBe('hatachi no haru')
    expect(romaji('貴女に会いたい')).toBe('anata ni aitai')
  })

  it('leaves English alone and handles full-width spaces and brackets', () => {
    expect(romaji('Hello 世界、ラブソング')).toBe('Hello sekai, rabusongu')
    expect(romaji('明日また会おうね　「さよなら」')).toBe('ashita mata aou ne sayonara')
  })
})

describe('reading fixes', () => {
  it('applies a fix to every match and keeps the standard reading', () => {
    const line = romajiLine('永遠の瞬間を永遠に', { 永遠: 'towa' })
    expect(line.text).toBe('towa no shunkan o towa ni')
    const fixed = line.words.filter((w) => w.fixed)
    expect(fixed.map((w) => [w.source, w.standard, w.text])).toEqual([
      ['永遠', 'eien', 'towa'],
      ['永遠', 'eien', 'towa'],
    ])
  })

  it('offers yuube for 昨夜', () => {
    const word = romajiLine('昨夜の夢を見た').words.find((w) => w.source === '昨夜')
    expect(word).toMatchObject({ text: 'sakuya', alternatives: ['yuube'] })
  })

  it('suggests common lyric readings', () => {
    const word = romajiLine('瞬間を待つ').words.find((w) => w.source === '瞬間')
    expect(word).toMatchObject({ text: 'shunkan', alternatives: ['toki'], fixed: false })
  })

  it('keeps the original text of glued words so they can be fixed too', () => {
    const line = romajiLine('抱いて眠る', { 抱いて: 'idaite' })
    expect(line.text).toBe('idaite nemuru')
  })

  it('lays out punctuation and spaces like the plain text', () => {
    const line = romajiLine('待って、ずっと　ここで')
    expect(line.text).toBe('matte, zutto koko de')
    expect(line.words.map((w) => w.spaceBefore)).toEqual([false, false, true, true, true])
  })

  it('accepts readings typed in kana or romaji', () => {
    expect(normaliseReading(' とき ')).toBe('toki')
    expect(normaliseReading('Toki')).toBe('toki')
  })
})
