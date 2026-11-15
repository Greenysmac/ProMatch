# Changelog

Versions follow `major.minor.patch`. The release tag is `v` + the version (for example `v0.2.0`);
the update check compares it with the version the panel was built with.

## 0.3.0

- **Colour-managed sequences with reframed clips.** Calibration (ACEScct and other
  scene-referred working spaces) works when the clip isn't the sequence's size or is moved
  and scaled with Motion, for example 16:9 footage in a 9:16 sequence. It used to fail with
  "the captured frame isn't the test pattern". The test pattern now goes in the part of the
  clip that shows on screen (effect build 12: restart Premiere after updating).
- Captures of a clip that Motion shows only part of (16:9 footage in a 9:16 sequence, scaled
  up or cropped) are of its whole frame: fitted into the sequence frame for the capture, put
  back straight after, and cropped to the clip. More of the scene to match on. A clip with
  keyframed Motion is captured as framed, and a keyframed ProMatch Amount is left on, with a
  warning in the Log.
- **Sharper captures in vertical sequences.** When the clip fits bigger on its side (16:9 in
  9:16, 4:5, or 9:16 phone footage in 16:9), it is turned 90° for the capture too and turned
  back in the panel: 16:9 HD in a 9:16 HD sequence is captured at 1920×1080 instead of
  1080×608. A clip shown smaller than it could be (letterboxed, picture in picture) is captured
  at the bigger size, never upscaled past 100%. Scale to Frame Size is now read (through QE):
  captures switch it off for the instant, so its footprint is no longer worked out from the
  wrong size, and calibration places the pattern for it straight away instead of guessing.
- The effect tells Premiere its GPU render keeps up with playback, as the SDK recommends, and
  `effect.log` records the GPU filter's registration, its frame layout and any GPU render that
  can't run, so a switch to CPU rendering can be traced.
- **Rec. 709 sequences with linear compositing are calibrated.** In Premiere 27 the effect
  gets log footage (S-Log3) still as log there, and the colour management turns it into Rec. 709
  after ProMatch, so the applied match looked visibly off from the panel's After view. Apply now
  measures that, as it does for ACEScct, and builds the LUT for it (measured: the Program Monitor
  then matches the After view to 0.6/255). A sequence where the effect sees the displayed picture
  keeps the plain LUT.
- **Premiere 27.** The panel knows which Premiere it's in. In 27, a target clip with a Color
  Mode Effect gets a warning in the Log at capture: if it holds a grade, Premiere applies it
  after ProMatch, so toggle the clip's operations off while capturing and applying. The Apply
  result warns only for the clips that still have one after the Apply: Premiere can leave an
  empty one on a clip (it went once ProMatch was added), and scripting can't see its operations. Without the
  ProMatch effect, Apply explains a Color Mode Clip LUT instead of the retired Lumetri panel.
- **"Host script failed".** The panel's script keeps working when another panel has replaced
  Premiere's shared `JSON` with a broken copy. When it still can't connect, click the red label
  to try again, and the Log adds a `host.jsx diagnostics` line saying why. Troubleshooting steps
  are in docs/INSTALL.md.

## 0.2.0

- Captures are of one camera as shot: the selected clip under the playhead (else the top one),
  with the tracks above it hidden and its ProMatch effects at 0% just for the capture. No more
  muting tracks or switching effects off by hand.
- **New match** in the toolbar starts over: frames, points and settings cleared, and the next
  Apply makes a new effect.
- Split view: drag the divider to wipe between before and after.
- Viewer Gamma (γ in the toolbar): the frames and swatches are shown as the Program Monitor shows
  them at 1.96, 2.2 or 2.4. Auto reads it from the project as last saved. Display only: scopes,
  readouts and the LUT are unchanged.
- Zoomed in on a 4K frame, the After view is worked out at full resolution instead of enlarged
  from the 1280-pixel preview.
- Update check: once a day the panel asks GitHub for the latest release and shows a banner when
  there is a newer one. Click the version at the bottom of the panel to check now.
- Windows installer (`npm run package:win`): installs the panel and the ProMatch effect for all
  users, and stops if Premiere Pro or Media Encoder is open.
- **macOS.** The panel and the ProMatch effect on Mac (Apple Silicon and Intel, macOS 11+): the
  effect renders on Metal, or on the CPU, and the installer (`npm run package:mac`) is a `.pkg`.
  Undo and redo are ⌘Z and ⌘⇧Z there.
- A panel left open when Premiere quit no longer says "Host script failed" when Premiere
  starts: it waits for Premiere to finish loading.
- Edit LUT with the panel open behind Effect Controls brings it forward with the match, instead
  of sometimes closing it and leaving it closed.

## 0.1.0

First working build: point-pair matching, geometric and face-aware Auto, scopes, the native
ProMatch effect (CPU, CUDA, OpenCL) with the LUT stored in the project, Edit LUT round trip.
