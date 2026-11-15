/*
 * host.jsx — the ONLY code that touches Premiere Pro.
 *
 * Contract (same as Interviewed): every entry point takes one JSON string and
 * returns one JSON string,
 *   { "ok": true,  "data": <anything> }
 *   { "ok": false, "error": "message", "line": 123 }
 *
 * ES3 discipline: no const/let, arrows, forEach/map/indexOf or trim. A syntax
 * error here produces a silent panel, which is why PM_ping is also the load
 * sentinel the panel checks for.
 *
 * QE DOM (app.enableQE / qe.*) is undocumented. Everything that uses it is
 * listed in spikes/SPIKES.md with what is and is not verified.
 */

/*
 * All panels share Premiere's one ExtendScript engine, and some replace the
 * global JSON with an old or broken copy. Use JSON when it works, else these
 * (a broken JSON in _pmErr used to throw outside the guard: "EvalScript error.").
 */
function _pmQuote(s) {
    var out = '"';
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        var n = s.charCodeAt(i);
        if (c === '"' || c === "\\") out += "\\" + c;
        else if (c === "\n") out += "\\n";
        else if (c === "\r") out += "\\r";
        else if (c === "\t") out += "\\t";
        else if (n < 32) out += "\\u" + ("000" + n.toString(16)).slice(-4);
        else out += c;
    }
    return out + '"';
}

function _pmStringifyOwn(v) {
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "string" || v instanceof String) return _pmQuote(String(v));
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "function") return "null";
    var parts = [];
    if (Object.prototype.toString.call(v) === "[object Array]") {
        for (var i = 0; i < v.length; i++) parts.push(_pmStringifyOwn(v[i]));
        return "[" + parts.join(",") + "]";
    }
    for (var k in v) {
        if (!v.hasOwnProperty(k) || v[k] === undefined || typeof v[k] === "function") continue;
        parts.push(_pmQuote(k) + ":" + _pmStringifyOwn(v[k]));
    }
    return "{" + parts.join(",") + "}";
}

function _pmStringify(v) {
    try {
        var s = JSON.stringify(v);
        if (typeof s === "string") return s;
    } catch (e) {}
    return _pmStringifyOwn(v);
}

function _pmOk(data) {
    return _pmStringify({ ok: true, data: data });
}

function _pmErr(e) {
    var msg = (e && e.message) ? e.message : String(e);
    return _pmStringify({ ok: false, error: msg, line: (e && e.line) ? e.line : null });
}

function _pmParse(s) {
    if (!s) return {};
    try {
        var v = JSON.parse(s);
        if (v !== undefined) return v;
    } catch (e) {}
    // Only the panel's own JSON.stringify output arrives here (host.ts call).
    return eval("(" + s + ")");
}

function _pmWrap(fn, argJson) {
    try {
        return _pmOk(fn(_pmParse(argJson)));
    } catch (e) {
        return _pmErr(e);
    }
}

function _pmTicks(t) {
    return parseFloat(t.ticks);
}

/** A clip's effects in order, by display name, without the fixed Opacity and Motion (and ProMatch). `upTo`: stop before that index. */
function _pmEffectNames(clip, upTo) {
    var out = [];
    var n = upTo === undefined ? clip.components.numItems : upTo;
    for (var i = 0; i < n; i++) {
        var mn = String(clip.components[i].matchName);
        if (mn === "AE.ADBE Opacity" || mn === "AE.ADBE Motion" || mn === PM_COLOR_MODE_MATCH || mn.indexOf(PM_EFFECT_MATCH) !== -1) continue;
        out.push(String(clip.components[i].displayName));
    }
    return out;
}

/*
 * Premiere 27's Color Mode keeps a clip's grade in one "Color Mode Effect"
 * (no parameters for scripting). Effect Controls shows it last, under
 * ProMatch, and it renders there whatever the scripting order says (tested
 * 27.0.0): a capture includes it, but the match lands underneath it. It is
 * reported on its own (colorMode), not in the effect names. It can be there
 * without a grade: a clip with none had one when captured, gone once
 * ProMatch was added (tested 27.0.0), so it only means "may be graded".
 */
var PM_COLOR_MODE_MATCH = "AE.ADBE CompoundComponent";

function _pmHasColorMode(clip) {
    for (var i = 0; i < clip.components.numItems; i++) {
        if (String(clip.components[i].matchName) === PM_COLOR_MODE_MATCH) return true;
    }
    return false;
}

/**
 * The amount of a switched-on Lumetri vignette on the clip, else null. In
 * Lumetri's parameter list the Vignette section is a "Vignette" heading,
 * then its "Active" switch, then "Amount".
 */
function _pmVignette(clip) {
    for (var i = 0; i < clip.components.numItems; i++) {
        var comp = clip.components[i];
        if (String(comp.matchName).indexOf("Lumetri") === -1) continue;
        var inSection = false;
        var active = true;
        for (var p = 0; p < comp.properties.numItems; p++) {
            var name = String(comp.properties[p].displayName);
            if (name === "Vignette") {
                inSection = true;
                continue;
            }
            if (!inSection) continue;
            if (name === "Active") active = String(comp.properties[p].getValue()) === "true";
            if (name === "Amount") {
                var amount = Number(comp.properties[p].getValue());
                if (active && Math.abs(amount) > 0.01) return amount;
                break;
            }
        }
    }
    return null;
}

function _pmMuted(track) {
    return typeof track.isMuted === "function" && track.isMuted();
}

/** The clip on `track` under sequence time `pos` (ticks), else null. */
function _pmClipAt(track, pos) {
    for (var c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        if (_pmTicks(clip.start) <= pos && pos < _pmTicks(clip.end)) return clip;
    }
    return null;
}

/** Topmost visible video clip under the playhead (what the frame shows) as { clip, track }, else null. */
function _pmTopClip(seq) {
    var pos = _pmTicks(seq.getPlayerPosition());
    for (var t = seq.videoTracks.numTracks - 1; t >= 0; t--) {
        if (_pmMuted(seq.videoTracks[t])) continue;
        var clip = _pmClipAt(seq.videoTracks[t], pos);
        if (clip) return { clip: clip, track: t };
    }
    return null;
}

/**
 * The camera a capture is of: the topmost selected video clip under the
 * playhead, even on a hidden track, else the topmost visible one.
 */
function _pmCameraClip(seq) {
    var pos = _pmTicks(seq.getPlayerPosition());
    for (var t = seq.videoTracks.numTracks - 1; t >= 0; t--) {
        var clip = _pmClipAt(seq.videoTracks[t], pos);
        if (clip && clip.isSelected()) return { clip: clip, track: t };
    }
    return _pmTopClip(seq);
}

/** What the panel is told about a captured clip, with what was on it then. */
function _pmClipInfo(clip, t) {
    var multicam = false;
    try {
        multicam = !!(clip.projectItem && clip.projectItem.isMulticamClip && clip.projectItem.isMulticamClip());
    } catch (e1) {}
    // Its effects and media colour space: the panel checks both
    // frames had the same treatment (log converted on both, or neither).
    var media = null;
    try {
        var cs = clip.projectItem.getColorSpace();
        media = { name: String(cs.name), sceneReferred: !!cs.isSceneReferred };
    } catch (e2) {}
    var vignette = null;
    try {
        vignette = _pmVignette(clip);
    } catch (e3) {}
    var colorMode = false;
    try {
        colorMode = _pmHasColorMode(clip);
    } catch (e4) {}
    return { name: clip.name, track: t + 1, multicam: multicam, effects: _pmEffectNames(clip), media: media, vignette: vignette, colorMode: colorMode };
}

/** Topmost visible video clip under the playhead, as _pmClipInfo, else null. */
function _pmClipAtPlayhead(seq) {
    var top = seq ? _pmTopClip(seq) : null;
    return top ? _pmClipInfo(top.clip, top.track) : null;
}

/** Selected VIDEO track items with the indices QE needs to find them again. */
function _pmSelectedVideo(seq) {
    var out = [];
    if (!seq) return out;
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
        var track = seq.videoTracks[t];
        for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            if (clip.isSelected()) out.push({ clip: clip, track: t, index: c });
        }
    }
    return out;
}

/** The QE item for DOM clip #index on video track #track. QE interleaves
 *  "Empty" gap items, so count only real ones. */
function _pmQeItem(track, index) {
    var qt = qe.project.getActiveSequence().getVideoTrackAt(track);
    var k = -1;
    for (var i = 0; i < qt.numItems; i++) {
        var it = qt.getItemAt(i);
        if (it && it.type !== "Empty") {
            k++;
            if (k === index) return it;
        }
    }
    return null;
}

function _pmLastLumetri(clip) {
    var found = null;
    for (var i = 0; i < clip.components.numItems; i++) {
        var comp = clip.components[i];
        if (String(comp.matchName).indexOf("Lumetri") !== -1) found = comp;
    }
    return found;
}

/* ------------------------------------------------------------ entry points */

function PM_ping() {
    return _pmWrap(function () {
        var seq = app.project ? app.project.activeSequence : null;
        return {
            app: app.name || "Premiere Pro",
            version: app.version,
            hasActiveSequence: !!seq,
            sequence: seq ? seq.name : null
        };
    }, "");
}

/** The open project's .prproj path — LUTs are saved beside it. */
function PM_projectInfo() {
    return _pmWrap(function () {
        if (!app.project) return { name: null, path: null };
        return { name: app.project.name, path: app.project.path };
    }, "");
}

/**
 * Export the sequence frame at the playhead to `a.path` as PNG. QE's
 * exportFramePNG renders during the call but writes the file just after,
 * and may or may not append ".png" itself: the panel polls for both names.
 * With `a.raw` it is the camera alone (_pmCameraClip): the tracks above it
 * with a clip there hidden, its own track shown, its ProMatch effects at 0%,
 * and the whole of its frame fitted into the sequence's when Motion shows
 * only part of it (_pmFitWhole; info.clip.whole says where, so the panel
 * crops to it), all put back as soon as the export returns. Without
 * (calibration), the frame as the Program Monitor shows it.
 */
function PM_captureFrame(argJson) {
    return _pmWrap(function (a) {
        var seq = app.project.activeSequence;
        if (!seq) throw new Error("No active sequence. Open the sequence with your interview in the Timeline.");
        app.enableQE();
        var q = qe.project.getActiveSequence();
        var tc = q.CTI.timecode;
        var info = { timecode: tc, sequence: seq.name, width: seq.frameSizeHorizontal, height: seq.frameSizeVertical, clip: null };
        var pick = a.raw ? _pmCameraClip(seq) : _pmTopClip(seq);
        if (pick) info.clip = _pmClipInfo(pick.clip, pick.track);
        if (!a.raw || !pick) {
            q.exportFramePNG(tc, a.path);
            return info;
        }
        var pos = _pmTicks(seq.getPlayerPosition());
        var tracks = [];
        var amounts = [];
        var fit = null;
        try {
            for (var t = pick.track + 1; t < seq.videoTracks.numTracks; t++) {
                var above = seq.videoTracks[t];
                if (!_pmMuted(above) && _pmClipAt(above, pos)) {
                    above.setMute(1);
                    tracks.push({ track: above, muted: 0, n: t + 1 });
                }
            }
            var own = seq.videoTracks[pick.track];
            if (_pmMuted(own)) {
                own.setMute(0);
                tracks.push({ track: own, muted: 1, n: pick.track + 1 });
            }
            for (var k = 0; k < pick.clip.components.numItems; k++) {
                var comp = pick.clip.components[k];
                if (String(comp.matchName).indexOf(PM_EFFECT_MATCH) === -1) continue;
                var amount = _pmParam(comp, "Amount");
                var v = amount ? Number(amount.getValue()) : 0;
                if (!v) continue;
                amount.setValue(0, true);
                amounts.push({ param: amount, value: v });
            }
            try {
                fit = _pmFitWhole(seq, pick.clip);
            } catch (e0) {
                fit = { error: String(e0) };
            }
            q.exportFramePNG(tc, a.path);
        } finally {
            if (fit && fit.saved) {
                for (var s = fit.saved.length - 1; s >= 0; s--) {
                    try {
                        fit.saved[s].param.setValue(fit.saved[s].value, true);
                    } catch (e3) {}
                }
            }
            for (var i = amounts.length - 1; i >= 0; i--) {
                try {
                    amounts[i].param.setValue(amounts[i].value, true);
                } catch (e1) {}
            }
            for (var j = tracks.length - 1; j >= 0; j--) {
                try {
                    tracks[j].track.setMute(tracks[j].muted);
                } catch (e2) {}
            }
        }
        // What the capture left out, for the panel's log.
        info.clip.hidden = [];
        for (var h = 0; h < tracks.length; h++) if (!tracks[h].muted) info.clip.hidden.push(tracks[h].n);
        info.clip.shown = tracks.length > 0 && !!tracks[tracks.length - 1].muted;
        info.clip.bypassed = amounts.length;
        info.clip.raw = true;
        if (fit && fit.rect) info.clip.whole = { rect: fit.rect, width: fit.width, height: fit.height, reframed: !!fit.saved };
        if (fit && fit.keyframed) info.clip.keyframed = true;
        if (fit && fit.error) info.clip.fitError = fit.error;
        return info;
    }, argJson);
}

function PM_selection() {
    return _pmWrap(function () {
        var seq = app.project.activeSequence;
        var sel = _pmSelectedVideo(seq);
        var out = [];
        for (var i = 0; i < sel.length; i++) {
            out.push({ name: sel[i].clip.name, track: sel[i].track + 1, hasLumetri: !!_pmLastLumetri(sel[i].clip) });
        }
        return out;
    }, "");
}

/** Add a fresh Lumetri Color to every selected video clip. */
function PM_addLumetri() {
    return _pmWrap(function () {
        var seq = app.project.activeSequence;
        if (!seq) throw new Error("No active sequence.");
        var sel = _pmSelectedVideo(seq);
        if (!sel.length) throw new Error("Select the target camera's clip(s) in the Timeline first.");
        app.enableQE();
        var fx = qe.project.getVideoEffectByName("Lumetri Color");
        // QE returns an empty dummy (name "") for an unknown name, not null.
        if (!fx || !fx.name) throw new Error("Lumetri Color effect not found by name (non-English Premiere?).");
        var added = 0;
        var failed = [];
        for (var i = 0; i < sel.length; i++) {
            var it = _pmQeItem(sel[i].track, sel[i].index);
            if (!it) {
                failed.push(sel[i].clip.name);
                continue;
            }
            it.addVideoEffect(fx);
            added++;
        }
        return { added: added, failed: failed };
    }, "");
}

/* -------------------------------------------------- native ProMatch effect */

var PM_EFFECT_NAME = "ProMatch";
/** Contained in the component matchName (Premiere prefixes AE effects with "AE."). */
var PM_EFFECT_MATCH = "PRMT ProMatch";

function _pmFindEffect(clip) {
    for (var i = 0; i < clip.components.numItems; i++) {
        var comp = clip.components[i];
        if (String(comp.matchName).indexOf(PM_EFFECT_MATCH) !== -1) return { comp: comp, index: i };
    }
    return null;
}

function _pmParam(comp, name) {
    for (var p = 0; p < comp.properties.numItems; p++) {
        if (String(comp.properties[p].displayName) === name) return comp.properties[p];
    }
    return null;
}

/**
 * The match ID of a ProMatch effect: from its LUT text ("PMLUT3 <id> ..." or
 * "PMLUT2 <id> ...", effect build 7+; 0 for a LUT picked in Effect Controls),
 * else the visible Match ID of builds up to 6. 0 if none.
 */
function _pmMatchIdOf(comp) {
    var lutP = _pmParam(comp, "LUT");
    if (lutP) {
        var m = /^PMLUT[23] (\d+) /.exec(String(lutP.getValue()).substring(0, 32));
        if (m) return Number(m[1]);
    }
    var mid = _pmParam(comp, "Match ID");
    return mid ? Math.round(Number(mid.getValue())) : 0;
}

/** Every video clip in the sequence carrying a ProMatch effect with match ID `id`. */
function _pmClipsWithMatch(seq, id) {
    var out = [];
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
        var track = seq.videoTracks[t];
        for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            var fx = _pmFindEffect(clip);
            if (fx && _pmMatchIdOf(fx.comp) === id) out.push({ clip: clip, track: t, index: c });
        }
    }
    return out;
}

/**
 * The active sequence's colour settings (Premiere 25+). In a scene-referred
 * working space (ACEScct...) effects see working-space values, not the
 * display picture, and the panel calibrates (src/core/calibrate.ts).
 */
function PM_sequenceColour() {
    return _pmWrap(function () {
        var seq = app.project.activeSequence;
        if (!seq) throw new Error("No active sequence.");
        var s = seq.getSettings();
        var w = s.workingColorSpace;
        var working = w
            ? { name: String(w.name), isSceneReferred: !!w.isSceneReferred, primaries: Number(w.primaries), transfer: Number(w.transferCharacteristic), matrix: Number(w.matrixEquation) }
            : { name: "Rec. 709", isSceneReferred: false, primaries: 1, transfer: 1, matrix: 0 };
        return {
            sequence: seq.name,
            working: working,
            autoToneMap: String(s.autoToneMapEnabled) === "true",
            gamutCompression: String(s.autoInputGamutCompressionEnabled) === "true",
            linearComposite: String(s.compositeLinearColor) === "true"
        };
    }, "");
}

/** "1:1", "2:1" or "1.0" as a number, else 1. */
function _pmAspect(v) {
    var s = String(v);
    var m = /^\s*([\d.]+)\s*[:\/]\s*([\d.]+)\s*$/.exec(s);
    var r = m ? Number(m[1]) / Number(m[2]) : Number(s);
    return r > 0.1 && r < 10 ? r : 1;
}

/** A Motion parameter by display name, else by its usual index (non-English Premiere). */
function _pmMotionParam(comp, name, index) {
    var p = _pmParam(comp, name);
    if (p) return p;
    return index < comp.properties.numItems ? comp.properties[index] : null;
}

/** A parameter's value at media time `ticks` (keyframes live in the clip's media time). */
function _pmValueAt(prop, ticks) {
    if (typeof prop.isTimeVarying === "function" && prop.isTimeVarying()) {
        var t = new Time();
        t.ticks = String(ticks);
        return prop.getValueAtTime(t);
    }
    return prop.getValue();
}

/** The clip's own frame size and pixel aspect (a nested sequence's too), else null. */
function _pmMediaSize(clip) {
    try {
        var item = clip.projectItem;
        var w = 0, h = 0, par = 1;
        if (item.isSequence && item.isSequence()) {
            for (var s = 0; s < app.project.sequences.numSequences; s++) {
                var nest = app.project.sequences[s];
                if (nest.projectItem && nest.projectItem.nodeId === item.nodeId) {
                    w = Number(nest.frameSizeHorizontal);
                    h = Number(nest.frameSizeVertical);
                    try {
                        par = _pmAspect(nest.getSettings().videoPixelAspectRatio);
                    } catch (e1) {}
                }
            }
        } else {
            var m = /VideoInfo>\s*(\d+)\s*x\s*(\d+)/.exec(String(item.getProjectMetadata()));
            if (m) {
                w = Number(m[1]);
                h = Number(m[2]);
            }
            try {
                par = _pmAspect(item.getFootageInterpretation().pixelAspectRatio);
            } catch (e2) {}
        }
        return w > 0 && h > 0 ? { width: w, height: h, par: par } : null;
    } catch (e3) {
        return null;
    }
}

/**
 * For a capture, fit the clip's whole frame into the sequence frame when
 * Motion shows only part of it (16:9 footage in a 9:16 sequence): more of
 * the scene to match on. Centred, scaled to fit, no rotation or crop.
 * Returns { saved: [{ param, value }] to put back (null if nothing changed),
 * rect: where the clip's frame is in the sequence frame (fractions),
 * width, height: the clip's frame }, { keyframed: true } when Motion is
 * animated (changing it would add keyframes), or null when the clip's size
 * or Motion can't be read.
 */
function _pmFitWhole(seq, clip) {
    var media = _pmMediaSize(clip);
    if (!media) return null;
    var motion = null;
    for (var i = 0; i < clip.components.numItems; i++) {
        if (String(clip.components[i].matchName) === "AE.ADBE Motion") motion = clip.components[i];
    }
    if (!motion) return null;
    var names = ["Position", "Scale", "Scale Width", "Rotation", "Anchor Point", "Crop Left", "Crop Top", "Crop Right", "Crop Bottom"];
    var p = {};
    for (var n = 0; n < names.length; n++) {
        var prop = _pmParam(motion, names[n]);
        if (!prop) {
            if (n < 5) return null; // the crops are Premiere 26+ only
            continue;
        }
        if (typeof prop.isTimeVarying === "function" && prop.isTimeVarying()) return { keyframed: true };
        p[names[n]] = prop;
    }
    var uniform = _pmParam(motion, "Uniform Scale");
    var spar = 1;
    try {
        spar = _pmAspect(seq.getSettings().videoPixelAspectRatio);
    } catch (e0) {}
    // Display units (pixels times pixel aspect), the space Motion works in.
    var Sw = Number(seq.frameSizeHorizontal) * spar, Sh = Number(seq.frameSizeVertical);
    var Cw = media.width * media.par, Ch = media.height;
    var f = Math.min(Sw / Cw, Sh / Ch);
    var fw = (Cw * f) / Sw, fh = (Ch * f) / Sh;
    var rect = { x0: (1 - fw) / 2, y0: (1 - fh) / 2, x1: (1 + fw) / 2, y1: (1 + fh) / 2 };
    var out = { saved: null, rect: rect, width: media.width, height: media.height };
    // Already the whole clip, unrotated and uncropped: leave it.
    var pos = p["Position"].getValue(), anc = p["Anchor Point"].getValue();
    var sy = Number(p["Scale"].getValue()) / 100;
    var isUniform = !uniform || String(uniform.getValue()) === "true";
    var sx = isUniform ? sy : Number(p["Scale Width"].getValue()) / 100;
    var cx0 = Number(pos[0]) * Sw - sx * Number(anc[0]) * Cw, cy0 = Number(pos[1]) * Sh - sy * Number(anc[1]) * Ch;
    var cropped = false;
    for (var c = 5; c < names.length; c++) if (p[names[c]] && Math.abs(Number(p[names[c]].getValue())) > 1e-6) cropped = true;
    var turned = Math.abs(Number(p["Rotation"].getValue())) > 1e-6;
    var tol = 0.5;
    if (!cropped && !turned && cx0 >= -tol && cy0 >= -tol && cx0 + sx * Cw <= Sw + tol && cy0 + sy * Ch <= Sh + tol) {
        out.rect = { x0: cx0 / Sw, y0: cy0 / Sh, x1: (cx0 + sx * Cw) / Sw, y1: (cy0 + sy * Ch) / Sh };
        return out;
    }
    out.saved = [];
    var set = function (name, value) {
        if (!p[name]) return;
        out.saved.push({ param: p[name], value: p[name].getValue() });
        p[name].setValue(value, true);
    };
    set("Anchor Point", [0.5, 0.5]);
    set("Position", [0.5, 0.5]);
    set("Scale", f * 100);
    set("Scale Width", f * 100);
    set("Rotation", 0);
    for (var k = 5; k < names.length; k++) set(names[k], 0);
    return out;
}

/**
 * Where the clip at the playhead lands in the sequence frame, for the
 * calibration pattern (probePlacement in src/core/calibrate.ts). Premiere
 * hands effects the clip's own frame, which Motion then moves and scales
 * onto the sequence's: a 16:9 clip reframed in a 9:16 sequence shows only a
 * slice of it. Sizes in pixels with their pixel aspect; Motion's Position
 * as a fraction of the sequence frame and Anchor Point of the clip's, as
 * Premiere reports them; Scale and Scale Width in percent; Rotation in
 * degrees; crop (Premiere 26+) left, top, right, bottom in percent. media
 * and motion are null when they can't be read.
 */
function PM_clipGeometry() {
    return _pmWrap(function () {
        var seq = app.project.activeSequence;
        if (!seq) throw new Error("No active sequence.");
        var par = 1;
        try {
            par = _pmAspect(seq.getSettings().videoPixelAspectRatio);
        } catch (e0) {}
        var out = { sequence: { width: Number(seq.frameSizeHorizontal), height: Number(seq.frameSizeVertical), par: par }, clip: null, media: null, motion: null };
        var top = _pmTopClip(seq);
        if (!top) return out;
        var clip = top.clip;
        out.clip = { name: clip.name, track: top.track + 1 };
        out.media = _pmMediaSize(clip);
        try {
            var motion = null;
            for (var i = 0; i < clip.components.numItems; i++) {
                if (String(clip.components[i].matchName) === "AE.ADBE Motion") motion = clip.components[i];
            }
            if (motion) {
                var at = _pmTicks(seq.getPlayerPosition()) - _pmTicks(clip.start) + _pmTicks(clip.inPoint);
                var pos = _pmValueAt(_pmMotionParam(motion, "Position", 0), at);
                var anchor = _pmValueAt(_pmMotionParam(motion, "Anchor Point", 5), at);
                // Premiere 26+: Motion crops too, in percent of the clip's frame.
                var crop = [0, 0, 0, 0];
                var cropNames = ["Crop Left", "Crop Top", "Crop Right", "Crop Bottom"];
                for (var c = 0; c < 4; c++) {
                    var cp = _pmParam(motion, cropNames[c]);
                    if (cp) crop[c] = Number(_pmValueAt(cp, at)) || 0;
                }
                out.motion = {
                    position: [Number(pos[0]), Number(pos[1])],
                    scale: Number(_pmValueAt(_pmMotionParam(motion, "Scale", 1), at)),
                    scaleWidth: Number(_pmValueAt(_pmMotionParam(motion, "Scale Width", 2), at)),
                    uniform: String(_pmValueAt(_pmMotionParam(motion, "Uniform Scale", 3), at)) === "true",
                    rotation: Number(_pmValueAt(_pmMotionParam(motion, "Rotation", 4), at)),
                    anchor: [Number(anchor[0]), Number(anchor[1])],
                    crop: crop
                };
            }
        } catch (e4) {
            out.motion = null;
        }
        return out;
    }, "");
}

/**
 * One-click apply. Selected video clips get a ProMatch effect (added if
 * missing, reused if present) and its LUT parameter set to `lut`, the
 * effect's LUT text, which carries the match ID `id`. Every clip in the
 * sequence already using `id` is updated too. Setting the text re-renders.
 * The panel also uses it to show the calibration pattern (`lut` "PMLUTP n").
 */
function PM_applyMatch(argJson) {
    return _pmWrap(function (a) {
        var id = Math.round(Number(a.id));
        if (!(id > 0)) throw new Error("Bad match id.");
        var seq = app.project.activeSequence;
        if (!seq) throw new Error("No active sequence.");
        var sel = _pmSelectedVideo(seq);
        var existing = _pmClipsWithMatch(seq, id);
        if (!sel.length && !existing.length) {
            throw new Error("Select the target camera's clip(s) in the Timeline first.");
        }

        // Add the effect where it is missing.
        var added = [];
        var failed = [];
        var qeFx = null;
        for (var i = 0; i < sel.length; i++) {
            if (_pmFindEffect(sel[i].clip)) continue;
            if (!qeFx) {
                app.enableQE();
                qeFx = qe.project.getVideoEffectByName(PM_EFFECT_NAME);
                if (!qeFx || !qeFx.name) return { missingEffect: true, clips: [] };
            }
            var it = _pmQeItem(sel[i].track, sel[i].index);
            if (!it) {
                failed.push(sel[i].clip.name);
                continue;
            }
            if (it.addVideoEffect(qeFx) === false) {
                failed.push(sel[i].clip.name);
                continue;
            }
            added.push(sel[i].track + ":" + sel[i].index);
        }

        // Targets: selection + clips already on this id, without duplicates.
        var targets = [];
        var all = sel.concat(existing);
        for (var k = 0; k < all.length; k++) {
            var dup = false;
            for (var m = 0; m < targets.length; m++) {
                if (targets[m].track === all[k].track && targets[m].index === all[k].index) dup = true;
            }
            if (!dup && _pmFindEffect(all[k].clip)) targets.push(all[k]);
        }

        // Build 1 of the effect re-rendered via a Revision slider: one new
        // value for all of them, above any they have now. Build 2+ embeds the
        // LUT instead, and setting it re-renders by itself.
        var rev = null;
        for (var r = 0; r < targets.length; r++) {
            var rp = _pmParam(_pmFindEffect(targets[r].clip).comp, "Revision");
            if (rp) rev = Math.max(rev === null ? 0 : rev, Math.round(Number(rp.getValue())));
        }
        if (rev !== null) rev = (rev + 1) % 9999999;

        var clips = [];
        for (var q = 0; q < targets.length; q++) {
            var clip = targets[q].clip;
            var fx = _pmFindEffect(clip);
            var midP = _pmParam(fx.comp, "Match ID");  // builds up to 6 only
            var revP = _pmParam(fx.comp, "Revision");
            var lutP = _pmParam(fx.comp, "LUT");
            var before = _pmMatchIdOf(fx.comp);
            var embedded = false;
            var lutNote = lutP ? null : "no LUT parameter";
            if (lutP && a.lut) {
                try {
                    lutP.setValue(a.lut, true);
                    // Premiere stores the string as-is (UTF-16) without calling the
                    // effect's scan callback; the effect decodes it when rendering.
                    // Read it back to confirm the whole text was stored.
                    var back = String(lutP.getValue());
                    embedded = back === a.lut;
                    if (!embedded) lutNote = "read back " + back.length + " chars: " + back.substring(0, 24);
                } catch (e5) {
                    lutNote = String(e5);
                }
            }
            if (midP) midP.setValue(id, true);
            if (revP) revP.setValue(rev, true);
            var wasAdded = false;
            for (var x = 0; x < added.length; x++) if (added[x] === targets[q].track + ":" + targets[q].index) wasAdded = true;
            var colorMode = false;
            try {
                colorMode = _pmHasColorMode(clip);
            } catch (e6) {}
            clips.push({
                colorMode: colorMode,
                name: clip.name,
                track: targets[q].track + 1,
                added: wasAdded,
                previousId: before,
                embedded: embedded,
                lutNote: lutNote,
                before: _pmEffectNames(clip, fx.index),
                effects: _pmEffectNames(clip)
            });
        }
        return { missingEffect: false, revision: rev, clips: clips, failed: failed };
    }, argJson);
}

/**
 * Make Effect Controls redraw the selected clips' effects, so the ProMatch
 * effect relabels its LUT button: deselect and reselect them. Premiere asks
 * effects to update their controls on that, not when a script changes a
 * value or the playhead moves (tested, effect build 11). Must be its own
 * evalScript call after the change, or Premiere redraws the old value.
 */
function PM_refreshEffectControls() {
    return _pmWrap(function () {
        var seq = app.project.activeSequence;
        if (!seq) return 0;
        var sel = _pmSelectedVideo(seq);
        for (var i = 0; i < sel.length; i++) sel[i].clip.setSelected(false, true);
        for (var j = 0; j < sel.length; j++) sel[j].clip.setSelected(true, true);
        return sel.length;
    }, "");
}

/** Describe a parameter value fully enough to compare a hand-set Lumetri with
 *  a script-set one: blob-type params read back as odd strings ("ﺾ"), so
 *  the first char codes are recorded as well as the text. */
function _pmDescribe(prop) {
    var v, type;
    try {
        v = prop.getValue();
        type = typeof v;
        v = String(v);
    } catch (e) {
        return { type: "error", value: String(e) };
    }
    var codes = [];
    for (var c = 0; c < v.length && c < 16; c++) codes.push(v.charCodeAt(c).toString(16));
    return { type: type, value: v, length: v.length, codes: codes.join(" ") };
}

/** SPIKE: every component and parameter on the first selected clip, with
 *  parameter indices (Lumetri has duplicate names, e.g. two "Input LUT"). */
function PM_dumpEffects() {
    return _pmWrap(function () {
        var seq = app.project.activeSequence;
        var sel = _pmSelectedVideo(seq);
        if (!sel.length) throw new Error("Select one video clip in the Timeline.");
        var clip = sel[0].clip;
        var comps = [];
        for (var i = 0; i < clip.components.numItems; i++) {
            var comp = clip.components[i];
            var props = [];
            for (var p = 0; p < comp.properties.numItems; p++) {
                var prop = comp.properties[p];
                var d = _pmDescribe(prop);
                d.index = p;
                d.name = prop.displayName;
                props.push(d);
            }
            comps.push({ index: i, name: comp.displayName, matchName: comp.matchName, props: props });
        }
        return { clip: clip.name, components: comps };
    }, "");
}

/**
 * SPIKE: set ONLY the named Lumetri parameters (on the last Lumetri of the
 * first selected clip) to a value, and read them back. Names match every
 * parameter with that display name; "#12" targets parameter index 12.
 * Undo (Ctrl+Z) reverts it.
 */
function PM_trySetLut(argJson) {
    return _pmWrap(function (a) {
        var seq = app.project.activeSequence;
        var sel = _pmSelectedVideo(seq);
        if (!sel.length) throw new Error("Select one video clip with Lumetri Color on it.");
        var lum = _pmLastLumetri(sel[0].clip);
        if (!lum) throw new Error("The selected clip has no Lumetri Color.");
        var targets = a.params || ["LUTAsset"];
        var tried = [];
        for (var p = 0; p < lum.properties.numItems; p++) {
            var prop = lum.properties[p];
            var name = String(prop.displayName);
            var hit = false;
            for (var t = 0; t < targets.length; t++) {
                if (targets[t] === name || targets[t] === "#" + p) hit = true;
            }
            if (!hit) continue;
            var rec = { index: p, name: name, before: _pmDescribe(prop), after: null, error: null };
            try { prop.setValue(a.value, true); } catch (e4) { rec.error = String(e4); }
            rec.after = _pmDescribe(prop);
            tried.push(rec);
        }
        return { clip: sel[0].clip.name, tried: tried };
    }, argJson);
}
