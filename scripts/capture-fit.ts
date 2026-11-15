/**
 * Captures of a clip's whole frame (_pmFitWhole in jsx/host.jsx, then the
 * panel's cropBox and turnBack in src/core/capture.ts), across sequence and
 * clip shapes and sizes. host.jsx runs as is in a VM with mock clips; a small
 * renderer then puts the clip on screen with the Motion values it set, the
 * way Premiere does (scale about the anchor, turn clockwise, place at
 * Position), and the cut-out must be the whole clip, the right way up, at
 * the expected size. Run from scripts/test.ts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { cropBox, turnBack } from '../src/core/capture.ts'
import type { RgbaImage } from '../src/core/sample.ts'

type Check = (name: string, ok: boolean, detail?: string) => void

interface Setup {
  seq: [number, number]
  /** Sequence pixel aspect (default 1). */
  spar?: number
  clip: [number, number]
  /** Clip pixel aspect (default 1). */
  par?: number
  scale: number
  rotation?: number
  position?: [number, number]
  stf?: boolean
  keyframed?: boolean
}

interface Param {
  displayName: string
  value: unknown
  getValue(): unknown
  setValue(v: unknown, update: boolean): void
  isTimeVarying(): boolean
}

function param(name: string, value: unknown, keyframed = false): Param {
  return {
    displayName: name,
    value,
    getValue() {
      return this.value
    },
    setValue(v) {
      this.value = v
    },
    isTimeVarying: () => keyframed,
  }
}

function loadHost(): vm.Context {
  const ctx = vm.createContext({ app: {}, qe: {}, $: {}, JSON })
  vm.runInContext(readFileSync(join(import.meta.dirname, '..', 'jsx', 'host.jsx'), 'utf8'), ctx)
  return ctx
}

function mockClip(s: Setup) {
  const list = (items: Param[]) => Object.assign([...items], { numItems: items.length })
  const motion: Record<string, Param> = {
    Position: param('Position', s.position ?? [0.5, 0.5]),
    Scale: param('Scale', s.scale, s.keyframed),
    'Scale Width': param('Scale Width', s.scale),
    'Uniform Scale': param('Uniform Scale', 'true'),
    Rotation: param('Rotation', s.rotation ?? 0),
    'Anchor Point': param('Anchor Point', [0.5, 0.5]),
    'Crop Left': param('Crop Left', 0),
    'Crop Top': param('Crop Top', 0),
    'Crop Right': param('Crop Right', 0),
    'Crop Bottom': param('Crop Bottom', 0),
  }
  const components = list([])
  const comp = { matchName: 'AE.ADBE Motion', displayName: 'Motion', properties: list(Object.values(motion)) }
  Object.assign(components, { 0: comp, numItems: 1 })
  const clip = {
    name: 'clip',
    components,
    projectItem: {
      isSequence: () => false,
      getProjectMetadata: () => `<VideoInfo>${s.clip[0]} x ${s.clip[1]}</VideoInfo>`,
      getFootageInterpretation: () => ({ pixelAspectRatio: String(s.par ?? 1) }),
    },
  }
  const seq = { frameSizeHorizontal: s.seq[0], frameSizeVertical: s.seq[1], getSettings: () => ({ videoPixelAspectRatio: String(s.spar ?? 1) }) }
  const qeItem = {
    scaleToFrameSize: !!s.stf,
    setScaleToFrameSize(v: boolean) {
      this.scaleToFrameSize = v
      return true
    },
  }
  return { clip, seq, qeItem, motion }
}

/** The clip's picture: red follows u, green follows v, so any turn or flip shows. */
const colourAt = (u: number, v: number): [number, number, number] => [Math.round(u * 255), Math.round(v * 255), 128]

/**
 * The sequence frame as Premiere would export it: the clip (its frame
 * fitted to the sequence's first with Scale to Frame Size) scaled about its
 * anchor, turned clockwise, placed at Position, grey around it.
 */
function render(s: Setup, m: Record<string, Param>, stf: boolean): RgbaImage {
  const spar = s.spar ?? 1
  const [W, H] = s.seq
  const Sw = W * spar
  const Sh = H
  let Fw = s.clip[0] * (s.par ?? 1)
  let Fh = s.clip[1]
  if (stf) {
    const g = Math.min(Sw / Fw, Sh / Fh)
    Fw *= g
    Fh *= g
  }
  const pos = m.Position.value as number[]
  const anc = m['Anchor Point'].value as number[]
  const sy = Number(m.Scale.value) / 100
  const sx = String(m['Uniform Scale'].value) === 'true' ? sy : Number(m['Scale Width'].value) / 100
  const th = (Number(m.Rotation.value) * Math.PI) / 180
  const cos = Math.cos(th)
  const sin = Math.sin(th)
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Screen (display units) back to the clip frame: undo place, turn, scale.
      const dx = (x + 0.5) * spar - pos[0] * Sw
      const dy = y + 0.5 - pos[1] * Sh
      const rx = cos * dx + sin * dy
      const ry = -sin * dx + cos * dy
      const u = (rx / sx + anc[0] * Fw) / Fw
      const v = (ry / sy + anc[1] * Fh) / Fh
      const i = (y * W + x) * 4
      const c = u >= 0 && u < 1 && v >= 0 && v < 1 ? colourAt(u, v) : [60, 60, 60]
      data.set([c[0], c[1], c[2], 255], i)
    }
  }
  return { width: W, height: H, data }
}

function cut(img: RgbaImage, b: { x: number; y: number; w: number; h: number }): RgbaImage {
  const data = new Uint8ClampedArray(b.w * b.h * 4)
  for (let y = 0; y < b.h; y++) data.set(img.data.subarray(((b.y + y) * img.width + b.x) * 4, ((b.y + y) * img.width + b.x + b.w) * 4), y * b.w * 4)
  return { width: b.w, height: b.h, data }
}

/** Worst colour error against the clip's own picture, over the cut-out. */
function error(img: RgbaImage): number {
  let worst = 0
  for (let y = 0; y < img.height; y += 3) {
    for (let x = 0; x < img.width; x += 3) {
      const want = colourAt((x + 0.5) / img.width, (y + 0.5) / img.height)
      const i = (y * img.width + x) * 4
      worst = Math.max(worst, Math.abs(img.data[i] - want[0]), Math.abs(img.data[i + 1] - want[1]), Math.abs(img.data[i + 2] - want[2]))
    }
  }
  return worst
}

export function captureFitTests(check: Check): void {
  const host = loadHost()
  /**
   * Fit, render, cut out and turn back. `want`: the cut-out's size (± a
   * pixel or two for the edge trim), and whether it turned / changed Motion.
   */
  const run = (name: string, s: Setup, want: { size: [number, number]; turn: boolean; refit: boolean }) => {
    const { clip, seq, qeItem, motion } = mockClip(s)
    const fit = (host._pmFitWhole as (...a: unknown[]) => any)(seq, clip, qeItem)
    const stfDuring = qeItem.scaleToFrameSize
    const frame = render(s, motion, stfDuring)
    const box = cropBox(fit.rect, frame.width, frame.height) ?? { x: 0, y: 0, w: frame.width, h: frame.height }
    let img = cut(frame, box)
    if (fit.turn === 90) img = turnBack(img)
    // Put back as PM_captureFrame does.
    if (fit.stf) fit.stf.setScaleToFrameSize(true)
    if (fit.saved) for (let i = fit.saved.length - 1; i >= 0; i--) fit.saved[i].param.setValue(fit.saved[i].value, true)
    const restored = Number(motion.Scale.value) === s.scale && Number(motion.Rotation.value) === (s.rotation ?? 0) && qeItem.scaleToFrameSize === !!s.stf
    const sizeOk = Math.abs(img.width - want.size[0]) <= 3 && Math.abs(img.height - want.size[1]) <= 3
    const err = error(img)
    check(
      `  ...${name}`,
      sizeOk && (fit.turn === 90) === want.turn && !!fit.saved === want.refit && err <= 6 && restored,
      `${img.width}×${img.height}${fit.turn ? ', turned' : ''}${fit.saved ? ', refit' : ''}${fit.stf ? ', Scale to Frame Size off for it' : ''}; worst ${err}/255${restored ? '' : '; NOT PUT BACK'}`,
    )
  }
  console.log('capture of the whole clip: fitted, turned when that fits bigger, cut out and turned back')
  run('16:9 HD filling a 9:16 HD sequence: turned, at full size', { seq: [1080, 1920], clip: [1920, 1080], scale: 177.78 }, { size: [1920, 1080], turn: true, refit: true })
  run('16:9 HD fitted (letterboxed) in 9:16: turned too, 1920×1080 instead of 1080×608', { seq: [1080, 1920], clip: [1920, 1080], scale: 56.25 }, { size: [1920, 1080], turn: true, refit: true })
  run('16:9 UHD filling 9:16 HD: turned, half size (all the sequence has)', { seq: [1080, 1920], clip: [3840, 2160], scale: 88.89 }, { size: [1920, 1080], turn: true, refit: true })
  run('16:9 UHD with Scale to Frame Size, filling 9:16: switched off for it, turned', { seq: [1080, 1920], clip: [3840, 2160], scale: 316.05, stf: true }, { size: [1920, 1080], turn: true, refit: true })
  run('9:16 phone footage filling a 16:9 sequence: turned', { seq: [1920, 1080], clip: [1080, 1920], scale: 177.78 }, { size: [1080, 1920], turn: true, refit: true })
  run('16:9 in a 4:5 sequence (1080×1350): turned, 1350×759', { seq: [1080, 1350], clip: [1920, 1080], scale: 125 }, { size: [1350, 759], turn: true, refit: true })
  run('16:9 in a square sequence: no gain from turning, so not turned', { seq: [1080, 1080], clip: [1920, 1080], scale: 100 }, { size: [1080, 605], turn: false, refit: true })
  run('720p filling 9:16 HD: turned, at its own size (never upscaled)', { seq: [1080, 1920], clip: [1280, 720], scale: 266.67 }, { size: [1280, 720], turn: true, refit: true })
  run('720p zoomed in a 16:9 HD sequence: refit at its own size', { seq: [1920, 1080], clip: [1280, 720], scale: 200 }, { size: [1280, 720], turn: false, refit: true })
  run('720p at 100% in 16:9 HD (whole, small): left alone', { seq: [1920, 1080], clip: [1280, 720], scale: 100 }, { size: [1280, 720], turn: false, refit: false })
  run('HD at 100% in HD: left alone', { seq: [1920, 1080], clip: [1920, 1080], scale: 100 }, { size: [1920, 1080], turn: false, refit: false })
  run('UHD at 50% in HD: left alone', { seq: [1920, 1080], clip: [3840, 2160], scale: 50 }, { size: [1920, 1080], turn: false, refit: false })
  run('UHD with Scale to Frame Size at 100% in HD: left alone, footprint from the fitted size', { seq: [1920, 1080], clip: [3840, 2160], scale: 100, stf: true }, { size: [1920, 1080], turn: false, refit: false })
  run('UHD at 100% in HD (zoomed in): refit at half size', { seq: [1920, 1080], clip: [3840, 2160], scale: 100 }, { size: [1920, 1080], turn: false, refit: true })
  run('HD at 30% off to one side (picture in picture): refit to full size', { seq: [1920, 1080], clip: [1920, 1080], scale: 30, position: [0.8, 0.2] }, { size: [1920, 1080], turn: false, refit: true })
  run('HD turned 90° by the user in a 9:16 sequence: stays turned, captured upright', { seq: [1080, 1920], clip: [1920, 1080], scale: 100, rotation: 90 }, { size: [1920, 1080], turn: true, refit: true })
  run('anamorphic 2:1 pixels (1920×1080 → 3840 wide) in 9:16: turned, square pixels out', { seq: [1080, 1920], clip: [1920, 1080], par: 2, scale: 100 }, { size: [1920, 540], turn: true, refit: true })
  run('non-square sequence pixels (HDV 1440×1080): never turned', { seq: [1440, 1080], spar: 4 / 3, clip: [1920, 1080], scale: 150 }, { size: [1440, 1080], turn: false, refit: true })
  {
    const { clip, seq, qeItem } = mockClip({ seq: [1080, 1920], clip: [1920, 1080], scale: 177.78, keyframed: true })
    const fit = (host._pmFitWhole as (...a: unknown[]) => any)(seq, clip, qeItem)
    check('  ...keyframed Motion: left as framed', fit?.keyframed === true && fit.saved === undefined)
  }
  // Each Motion value the fit changes, keyframed on its own: nothing may be
  // set (setting a keyframed value would add or move keyframes), Scale to
  // Frame Size included.
  {
    const names = ['Position', 'Scale', 'Scale Width', 'Rotation', 'Anchor Point', 'Crop Left', 'Crop Top', 'Crop Right', 'Crop Bottom']
    const touched: string[] = []
    for (const name of names) {
      const { clip, seq, qeItem, motion } = mockClip({ seq: [1080, 1920], clip: [1920, 1080], scale: 177.78, stf: true })
      motion[name].isTimeVarying = () => true
      const before = JSON.stringify(Object.values(motion).map((p) => p.value))
      const fit = (host._pmFitWhole as (...a: unknown[]) => any)(seq, clip, qeItem)
      if (fit?.keyframed !== true || JSON.stringify(Object.values(motion).map((p) => p.value)) !== before || !qeItem.scaleToFrameSize) touched.push(name)
    }
    check('  ...any one of Position, Scale, Rotation, Anchor Point or a crop keyframed: nothing set', !touched.length, touched.length ? `touched with ${touched.join(', ')} keyframed` : '')
  }
}
