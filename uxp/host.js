/*
 * ProMatch UXP host: the UXP side of the panel.
 *
 * The panel page (src/panel, built into web/) runs in the <webview> in
 * index.html and calls the same PM_* functions it calls on jsx/host.jsx under
 * CEP. It posts { id, fn, arg } with window.uxpHost.postMessage; this file
 * answers with { id, reply } through webview.postMessage, where reply is the
 * envelope host.jsx returns: { ok: true, data } or { ok: false, error }.
 * src/panel/host.ts picks this transport when it finds window.uxpHost.
 *
 * Status (docs/UXP-PORT.md): PM_ping, PM_projectInfo and PM_selection are
 * ported, and PM_captureFrame for the frame as the Program Monitor shows it
 * (the calibration capture). The camera-alone capture, Apply and the rest
 * answer "not ported yet". None of this has run in Premiere yet.
 */
const ppro = require('premierepro')
const uxp = require('uxp')
const lfs = uxp.storage.localFileSystem

const view = document.getElementById('panel')
const errText = (e) => (e && (e.stack || e.message)) || String(e)

function reply(id, envelope) {
  view.postMessage(JSON.stringify({ id, reply: JSON.stringify(envelope) }))
}

async function context() {
  const project = await ppro.Project.getActiveProject()
  if (!project) throw new Error('No open project.')
  const seq = await project.getActiveSequence()
  return { project, seq }
}

async function exists(path) {
  try {
    await lfs.getEntryWithUrl(`file:${path}`)
    return true
  } catch {
    return false
  }
}

/** Poll for a file: exportSequenceFrame's return value can't be trusted (SPIKES.md, U1). */
async function waitFor(path, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await exists(path)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

const PORTED = {
  async PM_ping() {
    const { seq } = await context().catch(() => ({ seq: null }))
    return {
      app: (uxp.host && uxp.host.name) || 'Premiere Pro',
      version: (uxp.host && uxp.host.version) || '?',
      hasActiveSequence: !!seq,
      sequence: seq ? seq.name : null,
    }
  },

  async PM_projectInfo() {
    const project = await ppro.Project.getActiveProject()
    if (!project) return { name: null, path: null }
    return { name: project.name, path: project.path || null }
  },

  async PM_selection() {
    const { seq } = await context()
    if (!seq) throw new Error('No active sequence. Open the sequence with your interview in the Timeline.')
    const selection = await seq.getSelection()
    const items = await selection.getTrackItems()
    const out = []
    for (const item of items) {
      // Video only: a track item's type and track come from the item itself.
      if (typeof item.getType === 'function' && (await item.getType()) !== 1) continue
      const chain = await item.getComponentChain()
      let hasLumetri = false
      for (let i = 0; i < chain.getComponentCount(); i++) {
        const c = chain.getComponentAtIndex(i)
        if (/Lumetri/i.test(await c.getMatchName())) hasLumetri = true
      }
      out.push({ name: await item.getName(), track: (await item.getTrackIndex()) + 1, hasLumetri })
    }
    return out
  },

  /**
   * The frame at the playhead, as PNG at `a.path` (+ ".png"). Only the
   * Program Monitor view so far: `a.raw` (the camera alone, effects at 0%,
   * tracks above hidden, Motion fitted) needs _pmCameraClip and _pmFitWhole
   * ported first, so a raw capture says so instead of returning the wrong
   * frame.
   */
  async PM_captureFrame(a) {
    if (a && a.raw) throw new Error('Capture of the camera alone is not ported to UXP yet (docs/UXP-PORT.md, step 3).')
    const { seq } = await context()
    if (!seq) throw new Error('No active sequence. Open the sequence with your interview in the Timeline.')
    const time = await seq.getPlayerPosition()
    const size = await seq.getFrameSize()
    const full = String(a.path).replace(/\\/g, '/')
    const slash = full.lastIndexOf('/')
    const name = `${full.slice(slash + 1)}.png`
    // The folder must end in a separator and, on Windows, use backslashes (SPIKES.md, U1).
    const isWin = /^[A-Za-z]:/.test(full)
    const folder = isWin ? `${full.slice(0, slash).replace(/\//g, '\\')}\\` : `${full.slice(0, slash)}/`
    await ppro.Exporter.exportSequenceFrame(seq, time, name, folder, size.width, size.height)
    if (!(await waitFor(`${full}.png`, 15000))) throw new Error(`Premiere did not write the frame to ${full}.png`)
    return {
      timecode: `${time.seconds.toFixed(3)} s`,
      sequence: seq.name,
      width: size.width,
      height: size.height,
      clip: null,
    }
  },
}

view.addEventListener('message', async (e) => {
  let msg
  try {
    msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
  } catch {
    return
  }
  if (!msg || typeof msg.id !== 'number' || typeof msg.fn !== 'string') return
  const fn = PORTED[msg.fn]
  if (!fn) {
    reply(msg.id, { ok: false, error: `${msg.fn} is not ported to UXP yet (docs/UXP-PORT.md).` })
    return
  }
  try {
    reply(msg.id, { ok: true, data: await fn(msg.arg) })
  } catch (err) {
    reply(msg.id, { ok: false, error: errText(err) })
  }
})

view.addEventListener('loaderror', (e) => {
  const fail = document.getElementById('fail')
  fail.hidden = false
  fail.textContent = `The panel page did not load (${(e && e.message) || 'loaderror'}). Run npm run build:uxp, then reload the plugin.`
})
