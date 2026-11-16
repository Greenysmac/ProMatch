/**
 * Typed bridge to jsx/host.jsx (same transport as Interviewed: the argument
 * is JSON-stringified twice so it arrives as a safe JS string literal).
 *
 * Outside CEP (the panel opened in a plain browser for UI work) there is no
 * CSInterface; `available` is false and every call rejects with a clear
 * message instead of hanging.
 */

import type { ClipGeometry, ColourSetup } from '../core/calibrate.ts'

interface CSInterfaceLike {
  evalScript(script: string, callback: (result: string) => void): void
  getSystemPath(type: string): string
}

declare const CSInterface: { new (): CSInterfaceLike } | undefined
declare const SystemPath: { EXTENSION: string } | undefined

export interface CaptureInfo {
  timecode: string
  sequence: string
  width: number
  height: number
  clip: CaptureClip | null
}

/** The clip a capture shows, with what was on it then. */
export interface CaptureClip {
  name: string
  track: number
  multicam: boolean
  /** Its effects in order (display names), without Opacity, Motion and ProMatch. */
  effects?: string[]
  /** Lumetri vignette amount when one is switched on, else null. */
  vignette?: number | null
  /** Has a Color Mode Effect (Premiere 27): rendered after ProMatch, opaque to scripting, and possibly empty. */
  colorMode?: boolean
  /** The media's colour space; scene-referred = log or raw. */
  media?: { name: string; sceneReferred: boolean } | null
  /** Captured alone: its ProMatch effects at 0% and the tracks above it hidden for the capture. */
  raw?: boolean
  /** Tracks (V numbers) hidden for the capture. */
  hidden?: number[]
  /** Its own track was hidden, so shown for the capture. */
  shown?: boolean
  /** ProMatch effects set to 0% for the capture. */
  bypassed?: number
  /** ProMatch effects left on because their Amount is keyframed: the capture includes their match. */
  keyedMatch?: number
  /**
   * Where the clip's whole frame is in the captured sequence frame (fractions),
   * and the clip's frame size. `reframed`: Motion was changed for the capture
   * to fit all of it (16:9 footage in a 9:16 sequence); the panel crops to it.
   * `turn` 90: it was also turned 90° clockwise, because it fits bigger that
   * way; the panel turns it back.
   */
  whole?: { rect: { x0: number; y0: number; x1: number; y1: number }; width: number; height: number; reframed: boolean; turn?: number }
  /** Motion is keyframed, so the capture shows the clip as framed. */
  keyframed?: boolean
  /** Fitting the whole clip failed (why); the capture shows it as framed. */
  fitError?: string
}

export interface SelectedClip {
  name: string
  track: number
  hasLumetri: boolean
}

export interface ParamValue {
  type: string
  value: string
  length?: number
  /** First char codes in hex — blob params read back as odd strings. */
  codes?: string
}

export interface EffectDump {
  clip: string
  components: Array<{ index: number; name: string; matchName: string; props: Array<ParamValue & { index: number; name: string }> }>
}

export interface LutSpike {
  clip: string
  tried: Array<{ index: number; name: string; before: ParamValue; after: ParamValue; error: string | null }>
}

// CSInterface.js defines its class anywhere; only CEP injects __adobe_cep__.
const inCep = typeof (window as unknown as { __adobe_cep__?: unknown }).__adobe_cep__ !== 'undefined'
const cs: CSInterfaceLike | null = inCep && typeof CSInterface === 'function' ? new CSInterface() : null

/**
 * Inside the UXP plugin (uxp/), this page runs in a <webview> and the UXP side
 * answers the same PM_* calls over the message bridge: the page posts
 * `{ id, fn, arg }` with window.uxpHost.postMessage, and uxp/host.js posts back
 * `{ id, reply }`, where reply is the same JSON envelope host.jsx returns.
 * See docs/UXP-PORT.md.
 */
interface UxpHostLike {
  postMessage(message: string): void
}
const uxpHost = (window as unknown as { uxpHost?: UxpHostLike }).uxpHost
const inUxp = !cs && typeof uxpHost === 'object' && uxpHost !== null && typeof uxpHost.postMessage === 'function'

/** Which host answers the calls: 'cep' (jsx/host.jsx), 'uxp' (uxp/host.js) or null (a plain browser). */
export const transport: 'cep' | 'uxp' | null = cs ? 'cep' : inUxp ? 'uxp' : null

export const available = transport !== null

const UXP_TIMEOUT_MS = 60000
let uxpNext = 1
const uxpPending = new Map<number, (reply: string) => void>()
if (inUxp) {
  window.addEventListener('message', (e: MessageEvent) => {
    let msg: { id?: number; reply?: string }
    try {
      msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
    } catch {
      return
    }
    if (!msg || typeof msg.id !== 'number' || typeof msg.reply !== 'string') return
    const done = uxpPending.get(msg.id)
    if (done) {
      uxpPending.delete(msg.id)
      done(msg.reply)
    }
  })
}

function uxpCall(fn: string, arg?: unknown): Promise<string> {
  return new Promise((resolve) => {
    const id = uxpNext++
    const timer = setTimeout(() => {
      uxpPending.delete(id)
      resolve(JSON.stringify({ ok: false, error: `${fn}: no reply from the UXP host in ${UXP_TIMEOUT_MS / 1000} s` }))
    }, UXP_TIMEOUT_MS)
    uxpPending.set(id, (reply) => {
      clearTimeout(timer)
      resolve(reply)
    })
    uxpHost!.postMessage(JSON.stringify({ id, fn, arg }))
  })
}

function evalRaw(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!cs) {
      reject(new Error('Not running inside Premiere Pro.'))
      return
    }
    cs.evalScript(script, resolve)
  })
}

async function call<T>(fn: string, arg?: unknown): Promise<T> {
  let raw: string
  if (transport === 'uxp') {
    raw = await uxpCall(fn, arg)
  } else {
    const script = arg === undefined ? `${fn}()` : `${fn}(${JSON.stringify(JSON.stringify(arg))})`
    raw = await evalRaw(script)
  }
  if (raw === 'EvalScript error.' || raw === undefined) {
    throw new Error(`${fn}: ExtendScript error (host.jsx failed to load or threw outside its guard)`)
  }
  let parsed: { ok: boolean; data?: T; error?: string; line?: number }
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${fn}: unreadable reply: ${raw.slice(0, 200)}`)
  }
  if (!parsed.ok) throw new Error(`${parsed.error}${parsed.line ? ` (host.jsx line ${parsed.line})` : ''}`)
  return parsed.data as T
}

/** Load sentinel: if PM_ping is missing, host.jsx did not parse; try once to re-evaluate it. */
export async function connect(): Promise<{ app: string; version: string; sequence: string | null }> {
  if (transport === 'uxp') return call('PM_ping')
  if (!cs) throw new Error('Not running inside Premiere Pro.')
  const has = await evalRaw('typeof PM_ping')
  if (has !== 'function' && typeof SystemPath !== 'undefined') {
    const ext = cs.getSystemPath(SystemPath.EXTENSION).replace(/\\/g, '/')
    await evalRaw(`$.evalFile("${ext}/jsx/host.jsx")`)
  }
  return call('PM_ping')
}

/**
 * Why host.jsx is not answering, for the Log when connect() gives up. Each
 * check is a separate evalScript of plain ES3, so one failing does not hide
 * the others: is PM_ping defined, is the built-in JSON intact (_pmErr needs
 * it, so a broken JSON throws outside the guard), the Premiere version, and
 * the file's own load error with its line.
 */
export async function diagnose(): Promise<string> {
  if (transport === 'uxp') {
    return call<{ app: string; version: string }>('PM_ping').then(
      (p) => `UXP host answers: ${p.app} ${p.version}`,
      (e: Error) => `UXP host: ${e.message}`,
    )
  }
  if (!cs) return 'not in CEP'
  const ext = typeof SystemPath !== 'undefined' ? cs.getSystemPath(SystemPath.EXTENSION).replace(/\\/g, '/') : '?'
  const jsx = `${ext}/jsx/host.jsx`
  const checks: Array<[string, string]> = [
    ['typeof PM_ping', 'typeof PM_ping'],
    ['JSON', 'typeof JSON === "object" ? (typeof JSON.stringify) + "/" + (typeof JSON.parse) : typeof JSON'],
    ['premiere', 'String(app.version)'],
    ['engine', 'String($.engineName) + " " + String($.version)'],
    ['file', `(function(){var f=new File(${JSON.stringify(jsx)});return f.exists?"exists, "+f.length+" bytes":"missing"})()`],
    ['evalFile', `(function(){try{$.evalFile(${JSON.stringify(jsx)});return "ok, PM_ping is "+(typeof PM_ping)}catch(e){return "threw: "+e.message+" (line "+e.line+")"}})()`],
  ]
  const out: string[] = [`path ${jsx}`]
  for (const [label, script] of checks) {
    const raw = await Promise.race([
      evalRaw(script),
      new Promise<string>((r) => setTimeout(() => r('(no reply in 5 s)'), 5000)),
    ])
    out.push(`${label}: ${raw}`)
  }
  return out.join(' | ')
}

export const projectInfo = () => call<{ name: string | null; path: string | null }>('PM_projectInfo')
/** The frame at the playhead; `raw`: the camera's clip alone, without ProMatch (PM_captureFrame). */
export const captureFrame = (path: string, raw = true) => call<CaptureInfo>('PM_captureFrame', { path, raw })
export const selection = () => call<SelectedClip[]>('PM_selection')
export const addLumetri = () => call<{ added: number; failed: string[] }>('PM_addLumetri')
export const dumpEffects = () => call<EffectDump>('PM_dumpEffects')
export const trySetLut = (params: string[], value: string | number) => call<LutSpike>('PM_trySetLut', { params, value })

export interface ApplyResult {
  /** The ProMatch effect is not installed (Premiere did not find it by name). */
  missingEffect: boolean
  /** Only for build-1 effects, which re-render through a Revision slider. */
  revision?: number | null
  clips: Array<{
    name: string
    track: number
    added: boolean
    previousId: number
    /** The LUT is stored in the effect (saved with the project), not only read from AppData. */
    embedded: boolean
    /** Why it was not embedded. */
    lutNote: string | null
    /** The clip's effects listed before ProMatch (display names). Not the real order: see app.ts apply. */
    before: string[]
    /** All the clip's effects but ProMatch, Opacity and Motion. */
    effects: string[]
    /** It has a Color Mode Effect now, after the Apply (it may be empty: see app.ts colourModeGraded). */
    colorMode?: boolean
  }>
  failed?: string[]
}

export interface SequenceColour extends ColourSetup {
  sequence: string
}

export const sequenceColour = () => call<SequenceColour>('PM_sequenceColour')
/** How the clip at the playhead sits in the sequence frame (PM_clipGeometry), for the calibration pattern. */
export const clipGeometry = () => call<ClipGeometry>('PM_clipGeometry')

/** Reselect the selected clips so Effect Controls redraws (the effect's LUT name). */
export const refreshEffectControls = () => call<number>('PM_refreshEffectControls')

/** Open this panel, or bring it forward if it is open behind another. */
export function bringToFront(): void {
  try {
    ;(cs as unknown as { requestOpenExtension(id: string, params: string): void } | null)?.requestOpenExtension('com.promatch.panel.main', '')
  } catch {
    // Not in CEP: nothing to bring forward.
  }
  window.focus()
}

/** Open a web page in the user's browser (a new window outside CEP). */
export function openExternal(url: string): void {
  const open = (cs as unknown as { openURLInDefaultBrowser?(url: string): void } | null)?.openURLInDefaultBrowser
  if (open) open.call(cs, url)
  else window.open(url, '_blank')
}

/** Close this panel (the helper reopens it, see app.ts watchEditRequests). */
export function closeSelf(): void {
  ;(cs as unknown as { closeExtension(): void } | null)?.closeExtension()
}

/** `lut`: the effect's LUT text (toEmbeddedText in core/lut.ts, or the calibration pattern). */
export const applyMatch = (id: number, lut: string) => call<ApplyResult>('PM_applyMatch', { id, lut })
