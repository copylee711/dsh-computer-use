import { describe, expect, it } from 'vitest'
import { splitBlocks } from '../src/text.js'

describe('streaming prose written one paragraph per line', () => {
  const paragraph = (n: number): string => `第${n}段。` + '这是一段足够长的正文，用来确认它会单独成为一块。'.repeat(4)

  it('splits at line ends when the text has no blank line at all', () => {
    const text = ['《标题》', paragraph(1), paragraph(2), paragraph(3)].join('\n')
    const blocks = splitBlocks(text)
    expect(blocks.length).toBe(3)
    expect(blocks.join('')).toBe(text)
    // The short title rides along with the first paragraph instead of being a block of its own.
    expect(blocks[0]!.startsWith('《标题》\n第1段')).toBe(true)
    expect(blocks.every(block => block === blocks.at(-1) || block.endsWith('\n'))).toBe(true)
  })

  it('still keeps paragraphs whole when blank lines separate them', () => {
    const text = `${paragraph(1)}\n软换行的第二行，属于同一段。\n\n${paragraph(2)}`
    const blocks = splitBlocks(text)
    expect(blocks.length).toBe(2)
    expect(blocks[0]).toContain('软换行的第二行')
  })

  it('does not pull a table or a code block apart', () => {
    const table = ['| 列一 | 列二 |', '|---|---|', ...Array.from({ length: 8 }, (_, i) => `| 第 ${i} 行的内容比较长一些 | 值 ${i} |`)].join('\n')
    expect(splitBlocks(table)).toEqual([table])
    const code = ['```js', ...Array.from({ length: 12 }, (_, i) => `const value${i} = compute(${i})`), '```'].join('\n')
    expect(splitBlocks(code)).toEqual([code])
  })
})
