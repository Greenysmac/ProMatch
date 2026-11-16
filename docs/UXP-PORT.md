# Moving the panel from CEP to UXP

The roadmap item in the README. This builds on the UXP spikes in
[spikes/SPIKES.md](../spikes/SPIKES.md) (U1 to U5, 2026-10-24) and follows their verdict: the
CEP panel's page runs inside a UXP `<webview>` (full Chromium, so the frame views, loupe,
scopes and OpenCV keep working), and a small UXP host does the Premiere calls and the file
access over the message bridge. CEP stays the shipping panel until the UXP one does everything
it does.

## How it fits together

- `uxp/manifest.json`, `uxp/index.html`: the UXP plugin, one panel holding a `<webview>` on
  `plugin:/web/index.html`.
- `uxp/web/`: the CEP panel's page, copied in by `npm run build:uxp` (not committed).
- `uxp/host.js`: answers the panel's `PM_*` calls with the `premierepro` API, in the same
  `{ ok, data }` / `{ ok, error }` envelope `jsx/host.jsx` returns.
- `src/panel/host.ts`: picks its transport. Under CEP it calls `evalScript` as before; in the
  WebView it finds `window.uxpHost` and posts `{ id, fn, arg }`, and the host posts back
  `{ id, reply }`. Nothing else in the panel changes for the host calls.

Permissions: the WebView reaches only GitHub (the update check), the message bridge is local
only, and the host answers only messages from `plugin:` pages and writes captures only into
ProMatch's `captures` folder. `localFileSystem` stays `fullAccess` because the data folder
(`~/Library/Application Support/ProMatch`, `%APPDATA%\ProMatch`) and the LUTs beside the
project are outside the plugin's own folders.

Try it: `npm run build:uxp`, then in the UXP Developer Tools **Add Plugin** →
`uxp/manifest.json` → **Load**, and open **Window → UXP Plugins → ProMatch**.

## Steps

1. **Transport and shell (this branch).** `host.ts` speaks both ways; the plugin loads the
   page. Ported: `PM_ping`, `PM_projectInfo`, `PM_selection`, and `PM_captureFrame` for the
   frame as the Program Monitor shows it. Every other call answers "not ported yet". Checked
   outside Premiere only (typecheck, `npm test`, and the bridge against a stand-in host). To
   check in Premiere: the page loads, the host's replies reach the page (`webview.postMessage`
   in that direction wasn't part of U2c), and the `premierepro` calls in `PM_selection`.
2. **Files over the bridge.** `src/panel/node.ts` uses CEP's Node synchronously (`readText`,
   `writeText`, `exists`, `waitForFile`, `readDataUrl`, …), and the WebView has no `require`, so
   the panel falls back to pickers and downloads. Make `node.ts` async, back it with
   `uxp.storage.localFileSystem` through the host (`FS_*` calls), and await it at the call sites
   in `app.ts` (about 40). Captures, sessions, `calibration.json`, LUT saves and the data folder
   all hang off this.
3. **Capture of the camera alone.** Port `_pmCameraClip` and `_pmFitWhole`: hide the tracks
   above, show the camera's track, set its ProMatch effects to 0%, fit Motion to the whole
   frame and turn it when that fits bigger, then put it all back. Each of those is a
   `premierepro` action inside `lockedAccess` + `executeTransaction`. Then `PM_clipGeometry`,
   `PM_sequenceColour` and `PM_addLumetri`.
4. **Apply.** U3 showed the effect can be added. U4 showed UXP can't set the embedded LUT
   ("Illegal Parameter type") and that reading it may crash Premiere. Until Adobe fixes that:
   set only Match ID and Amount, and let the effect read the `.cube` by Match ID from the data
   folder (option 1 in SPIKES.md). That loses P9 (the project carrying its own LUT), so the
   panel should say so on Apply. Re-run U4 on each Premiere release; when the arbitrary-data
   parameter takes text, embed again. Never call `getStartValue()` on the LUT parameter.
5. **Edit LUT from Effect Controls.** `helper.html` opens the panel when the effect asks. Under
   UXP that is a second, hidden entrypoint or a command; to work out.
6. **Packaging.** A `.ccx` beside the CEP installer, the native effect unchanged.

## Not changing

`src/core` (U2: runs unchanged), the native effect, and the CEP panel, which keeps shipping
until step 4 has an answer the author is happy with.
