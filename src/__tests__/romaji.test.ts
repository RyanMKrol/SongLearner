import { beforeAll, describe, expect, it } from 'vitest'
import { hasJapanese, loadTokenizer, romanizeTokens } from '../lyrics/romaji'

// Vitest runs from the project root, where Node's loader reads the dictionary straight from disk.
const dicPath = 'node_modules/@sglkc/kuromoji/dict/'
let romaji: (text: string) => string

beforeAll(async () => {
  const tokenizer = await loadTokenizer(dicPath)
  romaji = (text) => romanizeTokens(tokenizer.tokenize(text))
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

  it('leaves English alone and handles full-width spaces and brackets', () => {
    expect(romaji('Hello 世界、ラブソング')).toBe('Hello sekai, rabusongu')
    expect(romaji('明日また会おうね　「さよなら」')).toBe('ashita mata aou ne sayonara')
  })
})
