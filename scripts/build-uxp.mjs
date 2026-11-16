/*
 * Build the UXP plugin's panel page: run the normal build, then copy the CEP
 * panel's page (index.html, css/, dist/, vendor/) into uxp/web/, which the
 * <webview> in uxp/index.html loads. Load uxp/manifest.json with the UXP
 * Developer Tools. See docs/UXP-PORT.md.
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'

execSync('node esbuild.mjs', { stdio: 'inherit' })
rmSync('uxp/web', { recursive: true, force: true })
mkdirSync('uxp/web', { recursive: true })
for (const p of ['index.html', 'css', 'dist', 'vendor']) cpSync(p, `uxp/web/${p}`, { recursive: true })
console.log('[build-uxp] uxp/web ready')
