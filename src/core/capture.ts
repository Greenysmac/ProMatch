/**
 * Captures of one clip's whole frame (PM_captureFrame / _pmFitWhole in
 * jsx/host.jsx): Premiere fits the clip into the sequence frame for the
 * export, turned 90° clockwise when that fits bigger, and the panel cuts it
 * out and turns it back.
 */
import type { RgbaImage } from './sample.ts'

/** A rectangle as fractions of a frame's width and height. */
export interface FracRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * The pixels of `rect` in a W × H capture, one pixel in from each edge that
 * isn't the frame's (scaling blends the clip's edge with what's around it),
 * or null when that is the whole frame or too small to be the clip.
 */
export function cropBox(rect: FracRect, W: number, H: number): { x: number; y: number; w: number; h: number } | null {
  // A hair of slack: 320.0000001 is pixel 320, not 321.
  const e = 1e-6
  let x0 = Math.ceil(rect.x0 * W - e)
  let y0 = Math.ceil(rect.y0 * H - e)
  let x1 = Math.floor(rect.x1 * W + e)
  let y1 = Math.floor(rect.y1 * H + e)
  if (x0 <= 0 && y0 <= 0 && x1 >= W && y1 >= H) return null
  if (x0 > 0) x0++
  if (y0 > 0) y0++
  if (x1 < W) x1--
  if (y1 < H) y1--
  x0 = Math.max(0, x0)
  y0 = Math.max(0, y0)
  x1 = Math.min(W, x1)
  y1 = Math.min(H, y1)
  if (x1 - x0 < 16 || y1 - y0 < 16) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * Turn an image 90° counter-clockwise: undoes Motion > Rotation 90 (which
 * Premiere turns clockwise), so a w × h capture becomes h × w. The clip's
 * (u, v) was on screen at (1 − v, u).
 */
export function turnBack(img: RgbaImage): RgbaImage {
  const { width: w, height: h } = img
  const out = new Uint8ClampedArray(w * h * 4)
  // Output is h wide, w tall: output (X, Y) comes from input (w − 1 − Y, X).
  for (let Y = 0; Y < w; Y++) {
    for (let X = 0; X < h; X++) {
      const i = (X * w + (w - 1 - Y)) * 4
      const o = (Y * h + X) * 4
      out[o] = img.data[i]
      out[o + 1] = img.data[i + 1]
      out[o + 2] = img.data[i + 2]
      out[o + 3] = img.data[i + 3]
    }
  }
  return { width: h, height: w, data: out }
}
