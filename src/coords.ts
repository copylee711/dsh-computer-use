/**
 * The model only ever sees one coordinate space: pixels of the most recent
 * screenshot of the current display. The plugin owns the conversion to
 * physical virtual-screen pixels, so the model never does scale arithmetic.
 */

export interface Display {
  /** Physical virtual-screen origin and size. */
  x: number
  y: number
  width: number
  height: number
  primary: boolean
  dpi: number
  name: string
}

export interface ScreenshotLimits {
  maxLongEdge: number
  maxPixels: number
}

export interface Size { width: number; height: number }
export interface Point { x: number; y: number }
export interface Rect extends Point, Size {}

/** Screenshot size for a display: fit both limits, keep aspect, never upscale. */
export function screenshotSize(display: Size, limits: ScreenshotLimits): Size {
  const { width, height } = display
  let scale = Math.min(1, limits.maxLongEdge / Math.max(width, height))
  if (width * height * scale * scale > limits.maxPixels) scale = Math.sqrt(limits.maxPixels / (width * height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** Screenshot pixels → physical virtual-screen pixels. Throws when outside the image. */
export function toPhysical(point: Point, display: Display, shot: Size): Point {
  const { x, y } = point
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Coordinates must be numbers.')
  if (x < 0 || y < 0 || x > shot.width || y > shot.height) {
    throw new Error(`Coordinate (${x}, ${y}) is outside the screenshot (${shot.width}x${shot.height}). Use coordinates from the latest screenshot.`)
  }
  const px = display.x + Math.round((x * display.width) / shot.width)
  const py = display.y + Math.round((y * display.height) / shot.height)
  return {
    x: Math.min(display.x + display.width - 1, px),
    y: Math.min(display.y + display.height - 1, py),
  }
}

/** Physical virtual-screen pixels → screenshot pixels (may fall outside for other displays). */
export function toScreenshot(point: Point, display: Display, shot: Size): Point {
  return {
    x: Math.round(((point.x - display.x) * shot.width) / display.width),
    y: Math.round(((point.y - display.y) * shot.height) / display.height),
  }
}

/** Screenshot-space region [x1, y1, x2, y2] → physical rect clamped to the display. */
export function regionToPhysical(region: readonly number[], display: Display, shot: Size): Rect {
  if (region.length !== 4) throw new Error('region must be [x1, y1, x2, y2].')
  const [x1, y1, x2, y2] = region as [number, number, number, number]
  const a = toPhysical({ x: Math.min(x1, x2), y: Math.min(y1, y2) }, display, shot)
  const b = toPhysical({ x: Math.max(x1, x2), y: Math.max(y1, y2) }, display, shot)
  const width = b.x - a.x
  const height = b.y - a.y
  if (width < 4 || height < 4) throw new Error('region is too small; give a box at least a few pixels wide.')
  return { x: a.x, y: a.y, width, height }
}

/** Is a physical point on this display? */
export function contains(display: Display, point: Point): boolean {
  return point.x >= display.x && point.y >= display.y && point.x < display.x + display.width && point.y < display.y + display.height
}
