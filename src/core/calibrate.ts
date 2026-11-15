/**
 * Colour-managed sequences. In a sequence whose working colour space is
 * scene-referred (ACEScct, and likely HLG or PQ), Premiere hands effects
 * working-space values (ACEScct is log) and converts to the display only after
 * them. Frames are captured as displayed, so the match is made on display
 * values, and a LUT built for those would land on the wrong encoding.
 *
 * The SDK has no call that converts colours for an effect, so the panel
 * measures what Premiere does after the effect instead: the effect draws a
 * test pattern of known working-space colours (PMLUTP, lut_engine.h), the
 * panel captures the frame and reads what each colour became on screen. That
 * gives D, working → display, as an n³ table. The LUT the effect then needs
 * is D⁻¹ ∘ match ∘ D: show what the camera recorded, match it, and find the
 * working-space value that displays as the matched colour.
 *
 * Premiere hands the effect the clip's own frame, which Motion then scales
 * and moves onto the sequence's. A clip that isn't the sequence's size, or is
 * reframed (16:9 footage in a 9:16 sequence), shows only part of its frame,
 * so the pattern goes in that part (probePlacement) and is read from where it
 * lands on screen.
 */
import type { Vec3 } from './color.ts'
import { solve } from './linalg.ts'
import { type Lut3D, bakeLut, sampleLutTetra } from './lut.ts'
import type { RgbaImage } from './sample.ts'

/** Grid size of the pattern: 17³ = 4913 colours, ~20 px cells at 1080p. */
export const PROBE_N = 17

/** A rectangle as fractions of a frame's width and height. */
export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

const FULL: Rect = { x0: 0, y0: 0, x1: 1, y1: 1 }

/**
 * Where the pattern goes: a cols × rows grid over `clip` (part of the
 * effect's frame), which shows on screen as `screen` (part of the captured
 * sequence frame).
 */
export interface ProbePlacement {
  cols: number
  rows: number
  clip: Rect
  screen: Rect
}

/**
 * The effect's LUT text that draws the pattern instead of the picture: over
 * the whole frame, or as placed (effect build 12+; the corners in millionths,
 * so no locale can misread them).
 */
export function probeText(n = PROBE_N, place?: ProbePlacement): string {
  if (!place) return `PMLUTP ${n}`
  const m = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1e6)
  const r = place.clip
  return `PMLUTP ${n} ${place.cols} ${place.rows} ${m(r.x0)} ${m(r.y0)} ${m(r.x1)} ${m(r.y1)}`
}

/**
 * How the clip at the playhead sits in the sequence frame, as Premiere
 * reports it (PM_clipGeometry in jsx/host.jsx). Sizes in pixels with their
 * pixel aspect. Motion's Position is a fraction of the sequence frame and
 * Anchor Point of the clip's; Scale and Scale Width in percent (Scale is
 * the height's when Uniform Scale is off); Rotation in degrees.
 */
export interface ClipGeometry {
  sequence: { width: number; height: number; par: number }
  clip: { name: string; track: number } | null
  media: { width: number; height: number; par: number } | null
  motion: {
    position: [number, number]
    scale: number
    scaleWidth: number
    uniform: boolean
    rotation: number
    anchor: [number, number]
    /** Motion's crop (Premiere 26+): left, top, right, bottom in percent of the clip's frame. */
    crop?: [number, number, number, number]
  } | null
  /** The clip has Scale to Frame Size on (read through QE); null or absent when unknown. */
  scaleToFrame?: boolean | null
}

/**
 * Where to draw the pattern so that it fills the part of the sequence frame
 * the clip covers, with square cells on screen. `scaleToFrame`: the clip has
 * Scale to Frame Size on, so Premiere first fits its frame to the sequence's
 * and Motion scales that (g.scaleToFrame; when that's unknown the panel
 * tries both).
 * Without the clip's size or Motion, the whole frame, as before. Throws when
 * the pattern can't be shown: the clip is rotated, off screen or too small.
 */
export function probePlacement(g: ClipGeometry, n = PROBE_N, scaleToFrame = g.scaleToFrame === true): ProbePlacement | undefined {
  const sq = g.sequence
  const md = g.media
  const m = g.motion
  if (!md || !m || ![m.position[0], m.position[1], m.anchor[0], m.anchor[1], m.scale, m.rotation].every(Number.isFinite)) return undefined
  // Display units: pixels times pixel aspect, the space Motion works in.
  const Sw = sq.width * sq.par
  const Sh = sq.height
  let Cw = md.width * md.par
  let Ch = md.height
  if (scaleToFrame) {
    const f = Math.min(Sw / Cw, Sh / Ch)
    Cw *= f
    Ch *= f
  }
  const turn = ((m.rotation % 360) + 360) % 360
  if (Math.min(turn, 360 - turn) > 0.01) {
    throw new Error(`the clip is rotated ${m.rotation}°. Set its Motion > Rotation to 0 while calibrating, then put it back`)
  }
  const sy = m.scale / 100
  const sx = (m.uniform ? m.scale : m.scaleWidth) / 100
  if (!(sx > 0 && sy > 0)) throw new Error('the clip is scaled to nothing (Motion > Scale is 0)')
  // The clip's frame on screen, and the part of it inside the sequence frame
  // and not cropped away.
  const cx0 = m.position[0] * Sw - sx * m.anchor[0] * Cw
  const cy0 = m.position[1] * Sh - sy * m.anchor[1] * Ch
  const cw = sx * Cw
  const ch = sy * Ch
  const [cl, ct, cr, cb] = (m.crop ?? [0, 0, 0, 0]).map((v) => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) / 100 : 0))
  const vx0 = Math.max(0, cx0 + cl * cw)
  const vy0 = Math.max(0, cy0 + ct * ch)
  const vx1 = Math.min(Sw, cx0 + (1 - cr) * cw)
  const vy1 = Math.min(Sh, cy0 + (1 - cb) * ch)
  if (vx1 <= vx0 || vy1 <= vy0) throw new Error('the clip at the playhead is outside the frame (check its Motion > Position)')
  const screen: Rect = { x0: vx0 / Sw, y0: vy0 / Sh, x1: vx1 / Sw, y1: vy1 / Sh }
  const clip: Rect = { x0: (vx0 - cx0) / cw, y0: (vy0 - cy0) / ch, x1: (vx1 - cx0) / cw, y1: (vy1 - cy0) / ch }
  const wPx = (screen.x1 - screen.x0) * sq.width
  const hPx = (screen.y1 - screen.y0) * sq.height
  const { cols, rows } = probeLayout(n, wPx, hPx)
  // Cells must survive scaling and compression: a few pixels on screen and
  // in the clip's frame (which, with Scale to Frame Size, is the fitted size).
  const frameW = scaleToFrame ? Cw / md.par : md.width
  const frameH = scaleToFrame ? Ch : md.height
  const cell = Math.min(wPx / cols, hPx / rows, ((clip.x1 - clip.x0) * frameW) / cols, ((clip.y1 - clip.y0) * frameH) / rows)
  if (cell < 4) throw new Error(`the clip covers too little of the frame to show the test pattern (cells of ${cell.toFixed(1)} px). Scale it up to fill the frame while calibrating`)
  return { cols, rows, clip, screen }
}

/**
 * The pattern's grid: n³ cells, close to square, over the whole frame. Same
 * arithmetic as pm::probeGrid in native/src/lut_engine.cpp (IEEE doubles
 * both sides, so they agree).
 */
export function probeLayout(n: number, width: number, height: number): { cols: number; rows: number } {
  const count = n * n * n
  const cols = Math.max(1, Math.ceil(Math.sqrt((count * width) / height)))
  return { cols, rows: Math.ceil(count / cols) }
}

/** Pattern colour of cell idx: red fastest, like a LUT. */
export function probeColour(n: number, idx: number): Vec3 {
  const k = 1 / (n - 1)
  return [(idx % n) * k, (Math.floor(idx / n) % n) * k, Math.floor(idx / (n * n)) * k]
}

export interface Calibration {
  n: number
  /** D: what each pattern colour looked like captured, display-encoded 0..1, n³ × 3 in LUT order. */
  table: number[]
  /** The pattern came back upside down (GPU frames can be bottom-up). */
  flipped: boolean
  /**
   * How surely the pattern was read, 0..1: the share of neighbouring cells
   * where more of a channel drawn also shows at least as much of that
   * channel. Display transforms keep that order (gamut matrices are
   * diagonal-heavy; brightness alone isn't kept, since adding blue can
   * darken); a frame that isn't the pattern scores about a half.
   */
  fit: number
}

function monotone(n: number, table: number[]): number {
  let ok = 0
  let all = 0
  for (let idx = 0; idx < n * n * n; idx++) {
    for (let c = 0; c < 3; c++) {
      const stride = n ** c
      if (Math.floor(idx / stride) % n === n - 1) continue
      all++
      if (table[(idx + stride) * 3 + c] >= table[idx * 3 + c] - 2 / 255) ok++
    }
  }
  return ok / all
}

/**
 * Read the pattern back from a captured frame, from where `place` puts it on
 * screen (else the whole frame). Each cell is averaged over its middle half,
 * away from edges that scaling or compression blur. Both vertical
 * orientations are tried; the one whose brightness follows the drawn colours
 * wins (see `fit`). Throws when neither does: the frame isn't the pattern, or
 * something covers it or moved it on its way to the screen.
 */
export function readProbe(img: RgbaImage, n = PROBE_N, place?: ProbePlacement): Calibration {
  const area = place?.screen ?? FULL
  const { cols, rows } = place ?? probeLayout(n, img.width, img.height)
  const ax = area.x0 * img.width
  const ay = area.y0 * img.height
  const aw = (area.x1 - area.x0) * img.width
  const ah = (area.y1 - area.y0) * img.height
  const count = n * n * n
  let best: Calibration | null = null
  for (const flipped of [false, true]) {
    const table: number[] = []
    for (let idx = 0; idx < count; idx++) {
      const col = idx % cols
      const row = Math.floor(idx / cols)
      const x0 = Math.floor(ax + ((col + 0.25) * aw) / cols)
      const x1 = Math.max(x0 + 1, Math.ceil(ax + ((col + 0.75) * aw) / cols))
      let y0 = Math.floor(ay + ((row + 0.25) * ah) / rows)
      let y1 = Math.max(y0 + 1, Math.ceil(ay + ((row + 0.75) * ah) / rows))
      // Mirrored within the area (the whole frame, when there's no placement).
      if (flipped) [y0, y1] = [Math.round(2 * ay + ah) - y1, Math.round(2 * ay + ah) - y0]
      y0 = Math.max(0, y0)
      y1 = Math.min(img.height, Math.max(y0 + 1, y1))
      const sum: Vec3 = [0, 0, 0]
      let k = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * img.width + x) * 4
          sum[0] += img.data[i]
          sum[1] += img.data[i + 1]
          sum[2] += img.data[i + 2]
          k++
        }
      }
      table.push(sum[0] / k / 255, sum[1] / k / 255, sum[2] / k / 255)
    }
    // A blank frame is "monotone" too: the pattern must also span a real range.
    const fit = Math.max(...table) - Math.min(...table) > 0.3 ? monotone(n, table) : 0
    if (!best || fit > best.fit) best = { n, table, flipped, fit }
  }
  if (!best || best.fit < 0.95) {
    throw new Error(
      `the captured frame isn't the test pattern (match ${(best?.fit ?? 0).toFixed(2)}). Put the playhead over the target clip, with nothing on the tracks above it (titles, captions, adjustment layers) and no effect after ProMatch that moves or crops it`,
    )
  }
  return best
}

/** D as a LUT: working-space colour in, displayed colour out. */
const displayLut = (cal: Calibration): Lut3D => ({ size: cal.n, data: Float32Array.from(cal.table) })

/**
 * The working-space colour (0..1) that D shows as `want`, nearest to `start`.
 * Levenberg–Marquardt on the interpolated table. Where `want` is beyond what
 * the display can show (past white, outside its gamut) it settles on the
 * closest it can, so highlights and saturated colours clip the way Premiere
 * clips them anyway.
 */
function invert(D: Lut3D, want: Vec3, start: Vec3): Vec3 {
  const tmp: Vec3 = [0, 0, 0]
  const at = (x: Vec3): Vec3 => {
    sampleLutTetra(D, x[0], x[1], x[2], tmp)
    return [tmp[0], tmp[1], tmp[2]]
  }
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  const h = 0.25 / (D.size - 1)
  let x: Vec3 = [clamp(start[0]), clamp(start[1]), clamp(start[2])]
  let f = at(x).map((v, c) => v - want[c]) as Vec3
  let err = f[0] ** 2 + f[1] ** 2 + f[2] ** 2
  let lambda = 1e-3
  for (let it = 0; it < 30 && err > 1e-10; it++) {
    // Jacobian by central differences (columns: d/dr, d/dg, d/db).
    const J: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    for (let j = 0; j < 3; j++) {
      const lo: Vec3 = [x[0], x[1], x[2]]
      const hi: Vec3 = [x[0], x[1], x[2]]
      lo[j] = clamp(x[j] - h)
      hi[j] = clamp(x[j] + h)
      const a = at(lo)
      const b = at(hi)
      const span = hi[j] - lo[j]
      for (let i = 0; i < 3; i++) J[i][j] = (b[i] - a[i]) / span
    }
    const JtJ = [0, 1, 2].map((r) => [0, 1, 2].map((c) => J[0][r] * J[0][c] + J[1][r] * J[1][c] + J[2][r] * J[2][c]))
    const Jtf = [0, 1, 2].map((r) => [-(J[0][r] * f[0] + J[1][r] * f[1] + J[2][r] * f[2])])
    let improved = false
    for (let tries = 0; tries < 8 && !improved; tries++) {
      const A = JtJ.map((row, r) => row.map((v, c) => (r === c ? v * (1 + lambda) + 1e-9 : v)))
      let step: number[][]
      try {
        step = solve(A, Jtf)
      } catch {
        lambda *= 10
        continue
      }
      const nx: Vec3 = [clamp(x[0] + step[0][0]), clamp(x[1] + step[1][0]), clamp(x[2] + step[2][0])]
      const nf = at(nx).map((v, c) => v - want[c]) as Vec3
      const nerr = nf[0] ** 2 + nf[1] ** 2 + nf[2] ** 2
      if (nerr < err) {
        x = nx
        f = nf
        err = nerr
        lambda = Math.max(1e-7, lambda / 3)
        improved = true
      } else {
        lambda *= 4
      }
    }
    if (!improved) break
  }
  return x
}

/**
 * The LUT for the effect in a calibrated sequence: for each working-space
 * colour, what it displays as (D), matched (`match`, display to display), and
 * back to the working space (D⁻¹).
 */
export function workingLut(cal: Calibration, match: (displayed: Vec3) => Vec3, size: number): Lut3D {
  const D = displayLut(cal)
  const n = cal.n
  const t = cal.table
  const shown: Vec3 = [0, 0, 0]
  const miss = (x: Vec3, want: Vec3) => {
    sampleLutTetra(D, x[0], x[1], x[2], shown)
    return (shown[0] - want[0]) ** 2 + (shown[1] - want[1]) ** 2 + (shown[2] - want[2]) ** 2
  }
  // Every other measured cell: where to look when the nearby ones are far off.
  const coarse: number[] = []
  for (let b = 0; b < n; b += 2) for (let g = 0; g < n; g += 2) for (let r = 0; r < n; r += 2) coarse.push(r + g * n + b * n * n)
  /** The measured cell that shows closest to `want`: near the input first, then anywhere. */
  const nearestCell = (want: Vec3, w: Vec3): Vec3 => {
    let best = -1
    let bd = Infinity
    const look = (idx: number) => {
      const d = (t[idx * 3] - want[0]) ** 2 + (t[idx * 3 + 1] - want[1]) ** 2 + (t[idx * 3 + 2] - want[2]) ** 2
      if (d < bd) {
        bd = d
        best = idx
      }
    }
    const c = w.map((v) => Math.round(Math.min(1, Math.max(0, v)) * (n - 1)))
    for (let b = Math.max(0, c[2] - 3); b <= Math.min(n - 1, c[2] + 3); b++)
      for (let g = Math.max(0, c[1] - 3); g <= Math.min(n - 1, c[1] + 3); g++)
        for (let r = Math.max(0, c[0] - 3); r <= Math.min(n - 1, c[0] + 3); r++) look(r + g * n + b * n * n)
    for (const idx of coarse) look(idx)
    return probeColour(n, best)
  }
  return bakeLut(size, (w) => {
    sampleLutTetra(D, w[0], w[1], w[2], shown)
    const want = match([shown[0], shown[1], shown[2]])
    // From the input itself (smooth where the display isn't clipped), and
    // from the closest measured cell (where the input sits in a clipped
    // region, the slope there is zero and the first start can't move).
    const a = invert(D, want, w)
    const ea = miss(a, want)
    if (ea < 1e-6) return a
    const b = invert(D, want, nearestCell(want, w))
    return miss(b, want) < ea ? b : a
  })
}

/**
 * A sequence's colour setup, as Premiere reports it (PM_sequenceColour in
 * jsx/host.jsx). It decides both how captures look and what the effect sees,
 * so frames are tagged with the one they were captured under.
 */
export interface ColourSetup {
  working: { name: string; isSceneReferred: boolean; primaries: number; transfer: number; matrix: number }
  autoToneMap: boolean
  gamutCompression: boolean
  linearComposite: boolean
}

/** Equal for setups that capture and render the same way. */
export function setupKey(c: ColourSetup): string {
  const w = c.working
  return JSON.stringify([w.name, w.isSceneReferred, w.primaries, w.transfer, w.matrix, c.autoToneMap, c.gamutCompression, c.linearComposite])
}

/** Short name for labels: the working space, plus the switches that are on. */
export function setupName(c: ColourSetup): string {
  const on = [c.autoToneMap && 'tone mapping', c.gamutCompression && 'gamut compression', c.linearComposite && 'linear compositing'].filter(Boolean)
  return on.length ? `${c.working.name} (${on.join(', ')})` : c.working.name
}

/**
 * Does this setup need calibrating? Plain Rec.709 doesn't: effects see the
 * display picture there (spikes P7, P10). With linear compositing on they
 * may not (Premiere 27, S-Log3 media in a Rec.709 sequence: the match landed
 * visibly off), so that is measured too; if it measures as the display
 * picture after all, `isIdentity` keeps the plain LUT.
 */
export function needsCalibration(c: { working: { name: string; isSceneReferred: boolean }; linearComposite?: boolean }): boolean {
  return c.working.isSceneReferred || !!c.linearComposite || !/^Rec\.? ?709$/i.test(c.working.name.trim())
}

/**
 * Does Premiere show what the effect outputs unchanged? Within capture noise:
 * 8-bit frames, cells averaged, and the CPU path's 0.4/255 shift (P7).
 */
export function isIdentity(cal: Calibration, meanTol = 1 / 255, maxTol = 4 / 255): boolean {
  const count = cal.n ** 3
  let sum = 0
  for (let idx = 0; idx < count; idx++) {
    const want = probeColour(cal.n, idx)
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(cal.table[idx * 3 + c] - want[c])
      if (d > maxTol) return false
      sum += d
    }
  }
  return sum / (count * 3) <= meanTol
}
