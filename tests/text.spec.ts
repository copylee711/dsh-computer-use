import { describe, expect, it } from 'vitest'
import { splitBlocks, typingPieces } from '../src/text.js'

const para = (n: number) => `第 ${n} 段：${'这是一段用于测试流式输入的正文内容。'.repeat(4)}`

describe('splitBlocks', () => {
  it('splits at blank lines and joins back to the exact original', () => {
    const text = `# 标题\n\n${para(1)}\n\n${para(2)}\n\n- 列表一\n- 列表二\n\n${para(3)}\n`
    const blocks = splitBlocks(text)
    expect(blocks.join('')).toBe(text)
    expect(blocks.length).toBeGreaterThan(2)
    // Every block but the last ends with its blank-line separator.
    for (const block of blocks.slice(0, -1)) expect(block.endsWith('\n\n')).toBe(true)
  })

  it('never splits inside a fenced code block, even with blank lines in it', () => {
    const code = '```ts\nconst a = 1\n\n\nconst b = 2\n```\n'
    const text = `${para(1)}\n\n${code}\n${para(2)}\n`
    const blocks = splitBlocks(text)
    expect(blocks.join('')).toBe(text)
    expect(blocks.some(block => block.includes(code))).toBe(true)
  })

  it('merges short paragraphs so a block is not a single line', () => {
    const text = 'a\n\nb\n\nc\n\nd\n'
    expect(splitBlocks(text)).toEqual([text])
  })

  it('keeps CRLF text intact', () => {
    const text = `${para(1)}\r\n\r\n${para(2)}\r\n`
    expect(splitBlocks(text).join('')).toBe(text)
  })
})

describe('typingPieces', () => {
  it('breaks after spaces and joins back exactly', () => {
    const text = 'the quick brown fox jumps over the lazy dog '.repeat(5)
    const pieces = typingPieces(text, 30)
    expect(pieces.join('')).toBe(text)
    expect(pieces.every(piece => piece.length <= 31)).toBe(true)
  })

  it('does not split emoji surrogate pairs', () => {
    const text = '😀'.repeat(40)
    for (const piece of typingPieces(text, 7)) expect(/^[\uD800-\uDBFF]/.test(piece) || piece === '').toBe(true)
    expect(typingPieces(text, 7).join('')).toBe(text)
  })
})
