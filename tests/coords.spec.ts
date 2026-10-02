import { describe, expect, it } from 'vitest'
import { regionToPhysical, screenshotSize, toPhysical, toScreenshot, type Display } from '../src/coords.js'

const limits = { maxLongEdge: 1366, maxPixels: 1_150_000 }
const primary: Display = { x: 0, y: 0, width: 2560, height: 1600, primary: true, dpi: 192, name: 'D1' }
const left: Display = { x: -1920, y: 200, width: 1920, height: 1080, primary: false, dpi: 96, name: 'D2' }

describe('screenshot sizing', () => {
  it('fits the long edge and pixel budget, keeping aspect', () => {
    const size = screenshotSize(primary, limits)
    expect(size.width * size.height).toBeLessThanOrEqual(1_150_000 + 2000)
    expect(size.width).toBeLessThanOrEqual(1366)
    expect(Math.abs(size.width / size.height - 1.6)).toBeLessThan(0.01)
  })
  it('never upscales small displays', () => {
    expect(screenshotSize({ width: 1024, height: 768 }, limits)).toEqual({ width: 1024, height: 768 })
  })
})

describe('coordinate mapping', () => {
  it('round-trips through physical pixels', () => {
    const shot = screenshotSize(primary, limits)
    const p = toPhysical({ x: 640, y: 400 }, primary, shot)
    expect(toScreenshot(p, primary, shot)).toEqual({ x: 640, y: 400 })
  })
  it('applies the display origin on secondary monitors', () => {
    const shot = screenshotSize(left, limits)
    expect(toPhysical({ x: 0, y: 0 }, left, shot)).toEqual({ x: -1920, y: 200 })
    const corner = toPhysical({ x: shot.width, y: shot.height }, left, shot)
    expect(corner).toEqual({ x: -1, y: 1279 })
  })
  it('rejects points outside the screenshot', () => {
    const shot = screenshotSize(primary, limits)
    expect(() => toPhysical({ x: shot.width + 5, y: 10 }, primary, shot)).toThrow(/outside/)
    expect(() => toPhysical({ x: -1, y: 10 }, primary, shot)).toThrow(/outside/)
  })
  it('maps zoom regions in either corner order', () => {
    const shot = screenshotSize(primary, limits)
    const r = regionToPhysical([200, 100, 100, 50], primary, shot)
    expect(r.x).toBe(toPhysical({ x: 100, y: 50 }, primary, shot).x)
    expect(r.width).toBeGreaterThan(150)
    expect(() => regionToPhysical([1, 1, 2, 2], primary, shot)).toThrow(/small/)
  })
})
