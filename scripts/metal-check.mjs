/*
 * CI check of the Metal kernel (macOS): Premiere compiles it at runtime, so a
 * mistake in it would otherwise first show up inside Premiere. Runs
 * native/build/bin/gputest (test/gputest_metal.cpp) on a made-up LUT and
 * frame and fails unless the kernel compiles, applies the LUT as the CPU does
 * (within 1/255) and draws the calibration pattern exactly as the CPU does.
 * A runner without a Metal device only warns.
 *   node scripts/metal-check.mjs [path/to/gputest]
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'pm-metal-'))
const n = 17
const lines = [`LUT_3D_SIZE ${n}`]
for (let b = 0; b < n; b++)
  for (let g = 0; g < n; g++)
    for (let r = 0; r < n; r++) {
      const [R, G, B] = [r, g, b].map((v) => v / (n - 1))
      lines.push([R * 0.9 + 0.05 * G, G ** 1.1, Math.min(1, B * 1.05 + 0.02)].map((v) => v.toFixed(6)).join(' '))
    }
writeFileSync(join(dir, 'lut.cube'), lines.join('\n') + '\n')
const w = 320
const h = 180
const px = Buffer.alloc(w * h * 4)
for (let i = 0; i < px.length; i++) px[i] = i % 4 === 3 ? 255 : (i * 2654435761) % 251
writeFileSync(join(dir, 'in.rgba'), px)

let out
try {
  out = execFileSync(process.argv[2] ?? 'native/build/bin/gputest', [join(dir, 'lut.cube'), join(dir, 'in.rgba'), String(w), String(h)], { encoding: 'utf8' })
} catch (e) {
  out = String(e.stdout ?? '') + String(e.stderr ?? '')
}
console.log(out.trim())
const runs = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
if (runs.some((r) => r.error === 'no Metal device')) {
  console.log('::warning::No Metal device on this runner: the Metal kernel was not checked.')
  process.exit(0)
}
const errors = runs.filter((r) => r.error).map((r) => r.error)
const bad = runs.filter((r) => r.run && 'max255' in r && r.max255 > (/pattern/.test(r.run) ? 0 : 1))
const patterns = runs.filter((r) => /pattern/.test(r.run ?? '')).length
if (errors.length || bad.length || patterns < 2) {
  console.log(`::error::Metal kernel check failed: ${[...errors, ...bad.map((r) => `${r.run} off by ${r.max255}/255`), patterns < 2 ? 'pattern runs missing' : ''].filter(Boolean).join('; ')}`)
  process.exit(1)
}
console.log('Metal kernel matches the CPU (LUT and calibration pattern).')
