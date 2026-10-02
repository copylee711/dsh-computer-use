import { describe, expect, it } from 'vitest'
import { keyCode, parseKeys, parseModifiers } from '../src/keys.js'

describe('key parsing', () => {
  it('maps xdotool names to virtual keys', () => {
    expect(parseKeys('ctrl+shift+t')).toEqual([[0x11, 0x10, 0x54]])
    expect(parseKeys('Return')).toEqual([[0x0d]])
    expect(parseKeys('super')).toEqual([[0x5b]])
    expect(parseKeys('alt+F4')).toEqual([[0x12, 0x73]])
    expect(parseKeys('Page_Down')).toEqual([[0x22]])
  })
  it('splits space-separated sequences into combos', () => {
    expect(parseKeys('ctrl+a Delete')).toEqual([[0x11, 0x41], [0x2e]])
  })
  it('handles the plus key and punctuation', () => {
    expect(parseKeys('+')).toEqual([[0xbb]])
    expect(parseKeys('ctrl++')).toEqual([[0x11, 0xbb]])
    expect(keyCode('/')).toBe(0xbf)
    expect(keyCode('F12')).toBe(0x7b)
  })
  it('rejects unknown keys with the offending name', () => {
    expect(() => parseKeys('ctrl+bogus')).toThrow(/bogus/)
    expect(() => parseKeys('  ')).toThrow()
  })
  it('flattens modifiers', () => {
    expect(parseModifiers('ctrl+shift')).toEqual([0x11, 0x10])
    expect(parseModifiers(undefined)).toEqual([])
  })
})
