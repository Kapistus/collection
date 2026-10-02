"use strict";
/* Card Scanner Test: standalone page.
   Camera (or a photo) -> white card outline -> read the name bar and the bottom-left set/number line with Tesseract.js
   -> identify on Scryfall: set code + collector number first, otherwise the name and a list of printings to pick from. */

const $ = s => document.querySelector(s);
const CARD_RATIO = 63 / 88;                       // width / height of a Magic card
// areas read, as fractions of the card (x, y, width, height)
const ZONES = {
  name: { x: 0.065, y: 0.040, w: 0.74, h: 0.066, label: "name", px: 90 },
  set:  { x: 0.035, y: 0.912, w: 0.48, h: 0.070, label: "set · number", px: 130 },
};
const LANGS = ["EN", "DE", "FR", "IT", "ES", "PT", "JA", "KO", "RU", "ZHS", "ZHT", "PH"];
const API = "https://api.scryfall.com";
const abs = p => new URL(p, location.href).href;

const video = $("#video"), still = $("#still"), stage = $("#stage"), overlay = $("#overlay");
let stream = null, source = null;                 // source: "video" | "photo" | "photoCard"
let workers = null, busy = false, setCodes = null;
let log = [], current = null;

// ------------------------------------------------------------------ status
function status(msg, cls = "") { const s = $("#status"); s.textContent = msg; s.className = "status " + cls; }

// ------------------------------------------------------------------ Scryfall (max ~10 requests per second)
let lastReq = 0;
async function sf(path) {
  const wait = lastReq + 110 - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastReq = Date.now();
  const r = await fetch(API + path, { headers: { Accept: "application/json" } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Scryfall ${r.status}`);
  return r.json();
}
async function loadSets() {
  if (setCodes) return setCodes;
  try { const d = await sf("/sets"); setCodes = new Set((d?.data || []).map(s => s.code.toUpperCase())); }
  catch { setCodes = new Set(); }
  return setCodes;
}

// ------------------------------------------------------------------ text reader
let workersP = null, readerState = "not loaded";
/** Load the two text readers once; concurrent callers share the same load. Fails after 90 s instead of hanging. */
function getWorkers() {
  if (workersP) return workersP;
  readerState = "loading…"; diag();
  status("Loading the text reader (about 9 MB, only the first time)…");
  const opts = { workerPath: abs("vendor/tesseract/worker.min.js"), corePath: abs("vendor/tesseract/core"), langPath: abs("vendor/tesseract/lang"), gzip: false };
  const load = (async () => {
    const [name, set] = await Promise.all([Tesseract.createWorker("eng", 1, opts), Tesseract.createWorker("eng", 1, opts)]);
    await name.setParameters({ tessedit_pageseg_mode: "7", preserve_interword_spaces: "1", user_defined_dpi: "300" });
    await set.setParameters({ tessedit_pageseg_mode: "4", preserve_interword_spaces: "1", user_defined_dpi: "300" });   // a few lines of text; no character limits (tested better)
    return { name, set };
  })();
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timed out after 90 s")), 90000));
  workersP = Promise.race([load, timeout]).then(w => { workers = w; readerState = "ready"; diag(); return w; },
    err => { workersP = null; readerState = "failed: " + (err?.message || err); diag(); throw err; });
  return workersP;
}

/** One line of live diagnostics under the picture, so problems can be reported. */
let motion = null, lastEvent = "";
function diag() {
  const el = $("#diag"); if (!el) return;
  const cam = source === "video" ? `${video.videoWidth}×${video.videoHeight}` : source ? "photo" : "off";
  el.textContent = `Text reader: ${readerState} · Camera: ${cam}` +
    (source === "video" ? ` · Card: ${cardRect ? `found (${Math.round(cardRect.h / video.videoHeight * 100)}% of picture height, edges ${Math.round(detCov * 100)}%)` : "not found"} · Movement: ${motion == null ? "–" : motion.toFixed(1)} (still below ${STILL}) · Auto: ${!$("#auto").checked ? "off" : armed ? "waiting for a still card" : "waiting for the card to change"}` : "") +
    (lastEvent ? ` · Last: ${lastEvent}` : "");
}
addEventListener("error", e => { status("Error: " + e.message, "bad"); lastEvent = "error"; diag(); });
addEventListener("unhandledrejection", e => { status("Error: " + (e.reason?.message || e.reason), "bad"); lastEvent = "error"; diag(); });

// ------------------------------------------------------------------ geometry
const srcSize = () => source === "video" ? [video.videoWidth, video.videoHeight] : [still.naturalWidth, still.naturalHeight];
/** The white outline, in stage pixels. */
function outlineRect() {
  const W = stage.clientWidth, H = stage.clientHeight;
  if (source === "photoCard") {                    // a photo of just the card: the outline is the photo itself
    const [sw, sh] = srcSize(), s = Math.min(W / sw, H / sh);
    return { x: (W - sw * s) / 2, y: (H - sh * s) / 2, w: sw * s, h: sh * s };
  }
  let h = H * 0.8, w = h * CARD_RATIO;
  if (w > W * 0.85) { w = W * 0.85; h = w / CARD_RATIO; }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}
/** How the source is drawn on the stage (object-fit cover, or contain for a photo of just the card). */
function fit() {
  const [sw, sh] = srcSize(), W = stage.clientWidth, H = stage.clientHeight;
  const s = source === "photoCard" ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
  return { s, ox: (W - sw * s) / 2, oy: (H - sh * s) / 2 };
}
const toStage = r => { const f = fit(); return { x: r.x * f.s + f.ox, y: r.y * f.s + f.oy, w: r.w * f.s, h: r.h * f.s }; };
const toSource = o => { const f = fit(); return { x: (o.x - f.ox) / f.s, y: (o.y - f.oy) / f.s, w: o.w / f.s, h: o.h / f.s }; };
/** The card area in source pixels: the detected card, else the guide outline. */
function cardRectInSource() {
  const [sw, sh] = srcSize();
  if (source === "photoCard") return { x: 0, y: 0, w: sw, h: sh };
  return cardRect || toSource(outlineRect());
}

// ------------------------------------------------------------------ finding the card in the picture
/* The picture is shrunk to 320 px wide; edges are found with a Sobel filter; long straight vertical and horizontal edges
   become candidate card sides, and the rectangle with a card's proportions whose sides are best covered by edges wins.
   Works for a card held roughly upright (up to about 5° tilt), at any distance and position. */
const DET_W = 320;
let cardRect = null, detMiss = 0, detCov = 0;
function detectCard() {
  const [sw, sh] = srcSize(); if (!sw || !sh) return null;
  const W = DET_W, H = Math.max(40, Math.round(DET_W * sh / sw));
  const cv = detectCard.cv || (detectCard.cv = document.createElement("canvas"));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext("2d", { willReadFrequently: true }); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  g.drawImage(srcEl(), 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data, n = W * H, gray = new Float32Array(n);
  for (let i = 0; i < n; i++) gray[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
  const sx = new Float32Array(n), sy = new Float32Array(n), col = new Float32Array(W), row = new Float32Array(H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, a = gray[i - W - 1], b = gray[i - W], c = gray[i - W + 1], l = gray[i - 1], r = gray[i + 1], e = gray[i + W - 1], f = gray[i + W], h = gray[i + W + 1];
    const ux = c + 2 * r + h - a - 2 * l - e, uy = e + 2 * f + h - a - 2 * b - c, vx = Math.abs(ux), vy = Math.abs(uy);
    sx[i] = ux; sy[i] = uy;
    if (vx > 2 * vy) col[x] += vx; else if (vy > 2 * vx) row[y] += vy;
  }
  const peaks = (arr, k) => {
    const idx = [...arr.keys()].sort((p, q) => arr[q] - arr[p]), out = [];
    for (const i of idx) { if (out.length >= k || arr[i] <= 0) break; if (out.every(j => Math.abs(j - i) > 3)) out.push(i); }
    return out.sort((p, q) => p - q);
  };
  const cols = peaks(col, 16), rows = peaks(row, 16);
  // a side scores where the gradient across it is strong AND has the same sign along the whole side
  // (a real edge is dark-to-light the same way everywhere; texture and clutter flip randomly)
  const EDGE = 40;
  const pick = (arr, i, step) => { const a = arr[i - step] || 0, b = arr[i], c = arr[i + step] || 0; return Math.abs(a) > Math.abs(b) ? (Math.abs(a) > Math.abs(c) ? a : c) : (Math.abs(b) > Math.abs(c) ? b : c); };
  const side = (vals) => { let sum = 0; for (const v of vals) sum += v; const sg = Math.sign(sum) || 1; let hit = 0; for (const v of vals) if (v * sg > EDGE) hit++; return vals.length ? hit / vals.length : 0; };
  const coverage = (L, R, T, B) => {
    const vl = [], vr = [], vt = [], vb = [];
    for (let y = T + 4; y <= B - 4; y += 2) { vl.push(pick(sx, y * W + L, 1)); vr.push(pick(sx, y * W + R, 1)); }
    for (let x = L + 4; x <= R - 4; x += 2) { vt.push(pick(sy, T * W + x, W)); vb.push(pick(sy, B * W + x, W)); }
    const c = [side(vl), side(vr), side(vt), side(vb)];
    return Math.min(...c) < 0.3 ? 0 : (c[0] + c[1] + c[2] + c[3]) / 4;   // every side must be at least partly visible (fingers may cover some)
  };
  const cands = [];
  for (const L of cols) for (const R of cols) {
    const w = R - L; if (w < W * 0.12) continue;
    const hExp = w / CARD_RATIO; if (hExp < H * 0.25 || hExp > H * 1.05) continue;
    for (const T of rows) {
      let B = -1, bestD = hExp * 0.1;
      for (const r of rows) { const dd = Math.abs(r - (T + hExp)); if (r > T && dd <= bestD) { bestD = dd; B = r; } }
      if (B < 0 || Math.abs(w / (B - T) - CARD_RATIO) / CARD_RATIO > 0.06) continue;
      const cov = coverage(L, R, T, B);
      if (cov > 0.7) cands.push({ L, R, T, B, cov, area: w * (B - T) });
    }
  }
  if (!cands.length) return null;
  const top = Math.max(...cands.map(c => c.cov));
  const best = cands.filter(c => c.cov >= top - 0.08).sort((p, q) => q.area - p.area)[0];   // the outer edge, not the inner frame
  const k = sw / W;
  return { x: best.L * k, y: best.T * k, w: (best.R - best.L) * k, h: (best.B - best.T) * k, cov: best.cov };
}
/** Track the card across frames: smooth small changes, jump to a new position only when it's seen twice. */
let pending = null;
function updateCard() {
  const r = detectCard();
  if (!r) { if (++detMiss > 3) { cardRect = null; detCov = 0; } return; }
  detMiss = 0; detCov = r.cov;
  const close = (a, b) => a && Math.abs(a.x - b.x) < b.w * 0.08 && Math.abs(a.y - b.y) < b.h * 0.08 && Math.abs(a.w - b.w) < b.w * 0.08;
  if (close(cardRect, r)) { const m = 0.5; cardRect = { x: cardRect.x + (r.x - cardRect.x) * m, y: cardRect.y + (r.y - cardRect.y) * m, w: cardRect.w + (r.w - cardRect.w) * m, h: cardRect.h + (r.h - cardRect.h) * m }; }
  else if (close(pending, r) || !cardRect) { cardRect = { x: r.x, y: r.y, w: r.w, h: r.h }; pending = null; }
  else pending = r;
}
function drawOverlay() {
  if (!source) { overlay.toggleAttribute("hidden", true); return; }
  overlay.toggleAttribute("hidden", false);   // an <svg> has no .hidden property
  const found = source === "photoCard" || !!cardRect;
  const W = stage.clientWidth, H = stage.clientHeight, o = source === "photoCard" ? outlineRect() : cardRect ? toStage(cardRect) : outlineRect(), r = o.w * 0.045;
  const rr = (x, y, w, h, r) => `M${x + r},${y}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - 2 * r}a${r},${r} 0 0 1 -${r},-${r}v-${h - 2 * r}a${r},${r} 0 0 1 ${r},-${r}z`;
  const zone = z => { const x = o.x + z.x * o.w, y = o.y + z.y * o.h, w = z.w * o.w, h = z.h * o.h;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#fff" stroke-width="1.5" stroke-dasharray="5 4" opacity=".9"/>
      <text x="${z === ZONES.name ? x + 3 : x + w + 6}" y="${z === ZONES.name ? y + h + 13 : y + h / 2 + 4}" fill="#fff" font-size="12" font-family="system-ui" style="paint-order:stroke" stroke="#000" stroke-width="3">${z.label}</text>`; };
  const label = (t, y) => `<text x="${W / 2}" y="${y}" text-anchor="middle" fill="#fff" font-size="14" font-family="system-ui" style="paint-order:stroke" stroke="#000" stroke-width="3">${t}</text>`;
  const small = source === "video" && cardRect && cardRect.h < MIN_CARD_PX;
  overlay.setAttribute("viewBox", `0 0 ${W} ${H}`);
  overlay.innerHTML = `<path d="M0,0H${W}V${H}H0Z ${rr(o.x, o.y, o.w, o.h, r)}" fill="rgba(0,0,0,${found ? .5 : .3})" fill-rule="evenodd"/>
    <path d="${rr(o.x, o.y, o.w, o.h, r)}" fill="none" stroke="#fff" stroke-width="${found ? 3 : 2}" ${found ? "" : 'stroke-dasharray="10 8" opacity=".8"'}/>` +
    (found ? zone(ZONES.name) + zone(ZONES.set) : label("Hold a card in front of the camera", o.y + o.h / 2)) +
    (small ? label("Move the card closer", Math.min(H - 10, o.y + o.h + 20)) : "");
}
new ResizeObserver(drawOverlay).observe(stage);

// ------------------------------------------------------------------ image processing
const srcEl = () => source === "video" ? video : still;
/** Cut a zone out of the card, scaled so the text is a good size for the reader, as dark text on a light background. */
function zoneCanvas(z, src = srcEl(), c = cardRectInSource()) {
  const sx = c.x + z.x * c.w, sy = c.y + z.y * c.h, sw = z.w * c.w, sh = z.h * c.h;
  const dh = z.px, dw = Math.round(dh * sw / sh), pad = 14;
  const cv = document.createElement("canvas"); cv.width = dw + 2 * pad; cv.height = dh + 2 * pad;
  const g = cv.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high";
  g.drawImage(src, sx, sy, sw, sh, pad, pad, dw, dh);
  const im = g.getImageData(pad, pad, dw, dh), d = im.data, n = dw * dh, gray = new Uint8ClampedArray(n), hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) { const v = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000; gray[i] = v; hist[gray[i]]++; }
  const pct = p => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * p) return v; } return 255; };
  const lo = pct(0.03), hi = pct(0.97), med = pct(0.5), span = Math.max(hi - lo, 1), invert = med < (lo + hi) / 2;
  for (let i = 0; i < n; i++) {
    let v = (gray[i] - lo) * 255 / span; v = v < 0 ? 0 : v > 255 ? 255 : v; if (invert) v = 255 - v;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  // erase solid horizontal bars (frame edges caught at the zone's top or bottom): rows that are mostly dark
  for (let y = 0; y < dh; y++) {
    let dark = 0; for (let x = 0; x < dw; x++) if (d[(y * dw + x) * 4] < 110) dark++;
    if (dark > dw * 0.55) for (let x = 0; x < dw; x++) { const k = (y * dw + x) * 4; d[k] = d[k + 1] = d[k + 2] = 255; }
  }
  const bg = invert ? 255 - Math.min(255, Math.max(0, (med - lo) * 255 / span)) : Math.min(255, Math.max(0, (med - lo) * 255 / span));
  g.fillStyle = `rgb(${bg},${bg},${bg})`; g.fillRect(0, 0, cv.width, cv.height);
  g.putImageData(im, pad, pad);
  return cv;
}
/** Small grayscale copy of the card area, for detecting a still card. */
function thumb() {
  const c = cardRectInSource(), cv = thumb.cv || (thumb.cv = Object.assign(document.createElement("canvas"), { width: 40, height: 56 }));
  const g = cv.getContext("2d", { willReadFrequently: true }); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  g.drawImage(srcEl(), c.x, c.y, c.w, c.h, 0, 0, 40, 56);
  const d = g.getImageData(0, 0, 40, 56).data, out = new Float32Array(40 * 56);
  for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  return out;
}
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
const spread = a => { let m = 0; for (const v of a) m += v; m /= a.length; let s = 0; for (const v of a) s += (v - m) ** 2; return Math.sqrt(s / a.length); };

// ------------------------------------------------------------------ parsing what was read
function cleanName(t) {
  let s = t.replace(/[\r\n]+/g, " ").replace(/[^A-Za-zÀ-ÿÆæŒœ',\- ]+/g, " ").replace(/\s+/g, " ").trim();
  const words = s.split(" ");
  while (words.length && words[0].length < 2 && !/^[AI]$/.test(words[0])) words.shift();        // junk from the frame
  while (words.length && words[words.length - 1].length < 2) words.pop();                        // junk from the mana cost
  return words.join(" ");
}
const CONFUSE = { "0": "O", "O": "0", "1": "I", "I": "1", "5": "S", "S": "5", "8": "B", "B": "8", "2": "Z", "Z": "2" };
function setVariants(tok) {
  const out = new Set([tok]);
  for (let i = 0; i < tok.length; i++) if (CONFUSE[tok[i]]) out.add(tok.slice(0, i) + CONFUSE[tok[i]] + tok.slice(i + 1));
  return [...out];
}
/** Collector number, set code candidates (checked against Scryfall's set list) and language from the bottom-left line. */
function parseSetLine(t, codes) {
  const text = t.toUpperCase().replace(/[•·*]/g, " • ");
  const num = (/(?:^|\s)0*(\d{1,4})(?:\s*\/\s*\d{1,4})?(?=\s|$)/m.exec(text) || [])[1] || "";
  const toks = text.split(/[^A-Z0-9]+/).filter(Boolean);
  let lang = "", sets = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (LANGS.includes(tok) && i > 0) lang ||= tok.toLowerCase();
    if (tok.length < 3 || tok.length > 5 || /^\d+$/.test(tok)) continue;
    const followedByLang = LANGS.includes(toks[i + 1] || "");
    for (const v of setVariants(tok)) if (codes.has(v)) { if (followedByLang) sets.unshift(v); else sets.push(v); break; }
  }
  return { num, sets: [...new Set(sets)].slice(0, 3), lang };
}
function similarity(a, b) {
  a = a.toLowerCase().replace(/[^a-z]/g, ""); b = b.toLowerCase().replace(/[^a-z]/g, "");
  if (!a || !b) return 0;
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[m][n] / Math.max(m, n);
}
const namesOf = c => [c.name, c.printed_name, ...(c.card_faces || []).flatMap(f => [f.name, f.printed_name])].filter(Boolean);

// ------------------------------------------------------------------ identifying the card
async function fuzzy(name) {
  const words = name.split(" ");
  for (let k = words.length; k >= Math.max(1, words.length - 2); k--) {   // drop up to 2 trailing words (mana cost junk)
    const q = words.slice(0, k).join(" "); if (q.length < 3) break;
    const c = await sf("/cards/named?fuzzy=" + encodeURIComponent(q));
    if (c) return c;
  }
  return null;
}
async function printsOf(card) {
  const d = await sf(`/cards/search?q=${encodeURIComponent("oracleid:" + card.oracle_id)}&unique=prints&order=released&dir=desc`);
  return d?.data?.length ? d.data : [card];
}
const stripZeros = cn => String(cn).replace(/^0+(?=\d)/, "");
async function identify(name, info) {
  // 1. set code + collector number = exact printing (checked against the name, when one was read)
  if (info.num && info.sets.length) {
    for (const code of info.sets) {
      const path = `/cards/${code.toLowerCase()}/${info.num}` + (info.lang && info.lang !== "en" ? "/" + info.lang : "");
      const c = await sf(path);
      if (c && (!name || Math.max(...namesOf(c).map(x => similarity(name, x))) >= 0.55)) return { card: c, how: "set+number" };
    }
  }
  // 2. the name, then narrow the printings down with whatever else was read
  if (name.length >= 3) {
    const named = await fuzzy(name);
    if (named) {
      const prints = await printsOf(named);
      const bySet = info.sets.length ? prints.filter(p => info.sets.includes(p.set.toUpperCase())) : [];
      const pool = bySet.length ? bySet : prints;
      const byNum = info.num ? pool.filter(p => stripZeros(p.collector_number) === info.num) : [];
      if (byNum.length === 1) return { card: byNum[0], how: bySet.length ? "name+set+number" : "name+number" };
      if (bySet.length === 1) return { card: bySet[0], how: "name+set" };
      if (prints.length === 1) return { card: prints[0], how: "name (one printing)" };
      return { card: null, how: "choose", named, prints, suggested: new Set((byNum.length ? byNum : bySet).map(p => p.id)) };
    }
  }
  return { card: null, how: "fail" };
}

// ------------------------------------------------------------------ one scan
/** Copy of the card area of the current frame, so reading isn't affected by the picture changing. */
function snapshotCard() {
  const [sw, sh] = srcSize(), r = cardRectInSource();
  const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
  const w = Math.max(1, Math.min(sw, Math.ceil(r.x + r.w)) - x), h = Math.max(1, Math.min(sh, Math.ceil(r.y + r.h)) - y);
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  cv.getContext("2d").drawImage(srcEl(), x, y, w, h, 0, 0, w, h);
  return { cv, rect: { x: r.x - x, y: r.y - y, w: r.w, h: r.h } };
}
/** Sharpness of the two read areas: variance of the Laplacian (higher = sharper edges). */
function sharpness(snap) {
  let total = 0;
  for (const z of [ZONES.name, ZONES.set]) {
    const c = snap.rect, sx = c.x + z.x * c.w, sy = c.y + z.y * c.h, sw = z.w * c.w, sh = z.h * c.h;
    const H = 48, W = Math.max(8, Math.round(H * sw / sh));
    const cv = sharpness.cv || (sharpness.cv = document.createElement("canvas")); cv.width = W; cv.height = H;
    const g = cv.getContext("2d", { willReadFrequently: true }); g.drawImage(snap.cv, sx, sy, sw, sh, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data, gray = new Float32Array(W * H);
    for (let i = 0; i < gray.length; i++) gray[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x, l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - W] - gray[i + W];
      sum += l; sum2 += l * l; n++;
    }
    total += sum2 / n - (sum / n) ** 2;
  }
  return total;
}
let mode = (() => { try { return localStorage.getItem("scanMode") === "2" ? 2 : 1; } catch { return 1; } })();
document.querySelector(`input[name=mode][value="${mode}"]`).checked = true;
document.querySelectorAll("input[name=mode]").forEach(r => r.onchange = () => {
  mode = +r.value; try { localStorage.setItem("scanMode", String(mode)); } catch {}
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Mode 2: look at 6 frames over about 0.7 s and keep the sharpest. */
async function sharpestSnapshot() {
  let best = null;
  for (let i = 0; i < 6; i++) {
    if (i) { await sleep(120); updateCard(); drawOverlay(); }
    if (!cardRect) continue;
    const snap = snapshotCard(); snap.sharp = sharpness(snap);
    if (!best || snap.sharp > best.sharp) best = snap;
  }
  return best || Object.assign(snapshotCard(), { sharp: 0 });
}

async function scan(trigger = "auto") {
  if (!source) return;
  if (busy) { if (trigger !== "auto") status("Still working on the previous scan…", "warn"); return; }
  lastEvent = `${trigger} capture ${new Date().toLocaleTimeString()}`; diag();
  busy = true; $("#capture").disabled = true;
  const t0 = performance.now();
  try {
    const useMode = source === "video" ? mode : 1;
    if (useMode === 2) status("Picking the sharpest frame…");
    const snap = useMode === 2 ? await sharpestSnapshot() : Object.assign(snapshotCard(), {});
    snap.sharp ??= sharpness(snap);
    const cn = zoneCanvas(ZONES.name, snap.cv, snap.rect), cs = zoneCanvas(ZONES.set, snap.cv, snap.rect);
    if (!workers) status("Waiting for the text reader to load…");
    const w = await getWorkers();
    status("Reading…");
    const [rn, rs, codes] = await Promise.all([w.name.recognize(cn), w.set.recognize(cs), loadSets()]);
    const t1 = performance.now();
    const name = cleanName(rn.data.text), info = parseSetLine(rs.data.text, codes);
    if (!name && !info.num && trigger === "auto") { status("No card text found. Hold the card upright, closer, in good light.", "warn"); return; }
    status("Looking up on Scryfall…");
    const res = await identify(name, info);
    const t2 = performance.now();
    current = { name, info, res, raw: { name: rn.data, set: rs.data }, crops: [cn, cs], ms: { read: t1 - t0, lookup: t2 - t1 }, entry: null, mode: useMode, sharp: snap.sharp };
    if (res.card) addLog(res.card, res.how, t2 - t0);
    else if (res.how === "fail") addLog(null, "fail", t2 - t0, name || info.sets.join("/") || "(nothing read)");
    renderResult();
    status(res.card ? `Found: ${res.card.name}` : res.how === "choose" ? "Name found. Choose the printing you have." : "Not recognised. Try again, or type the name.",
      res.card ? "ok" : res.how === "choose" ? "warn" : "bad");
  } catch (err) {
    console.error(err); status("Error: " + err.message, "bad");
  } finally { busy = false; $("#capture").disabled = !source; }
}

// ------------------------------------------------------------------ results and log
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const img = (c, size = "normal") => c.image_uris?.[size] || c.card_faces?.[0]?.image_uris?.[size] || "";
const HOW = { "set+number": ["exact", "Set and number"], "name+set+number": ["exact", "Name, set and number"], "name+number": ["exact", "Name and number"],
  "name+set": ["exact", "Name and set"], "name (one printing)": ["exact", "Name (only one printing)"], "chosen": ["name", "Name, printing chosen"],
  "typed": ["name", "Typed, printing chosen"], "typed-choose": ["name", "Typed: choose the printing"], "choose": ["name", "Name only: choose the printing"], "fail": ["fail", "Not recognised"] };
const tag = how => `<span class="tag ${HOW[how][0]}">${HOW[how][1]}</span>`;
function renderResult() {
  const c = current; if (!c) return;
  $("#resultPanel").hidden = false;
  const card = c.res.card;
  $("#result").innerHTML = card
    ? `<div class="result"><img src="${esc(img(card))}" alt=""><div><div class="name">${esc(card.printed_name || card.name)}</div>
        <div>${esc(card.set_name)} · ${esc(card.set.toUpperCase())} #${esc(card.collector_number)}${card.lang !== "en" ? " · " + esc(card.lang.toUpperCase()) : ""}</div>
        <p>${tag(c.res.how)}</p><p class="hint">Mode ${c.mode} · read ${Math.round(c.ms.read)} ms · lookup ${Math.round(c.ms.lookup)} ms${c.sharp != null ? ` · sharpness ${Math.round(c.sharp)}` : ""}</p></div></div>`
    : `<p>${tag(c.res.how)}</p>` + (c.res.named ? `<p><b>${esc(c.res.named.name)}</b>: ${c.res.prints.length} printings.</p>` : "");
  const pw = $("#pickerWrap"); pw.hidden = !c.res.prints || !!card;
  if (c.res.prints && !card) {
    $("#pickerHint").textContent = c.res.suggested.size ? "Green = matches what was read." : "Pick the printing you have (newest first).";
    $("#picker").innerHTML = c.res.prints.map(p => `<button data-id="${esc(p.id)}" class="${c.res.suggested.has(p.id) ? "sug" : ""}">
      <img src="${esc(img(p, "small"))}" alt="" loading="lazy"><span>${esc(p.set.toUpperCase())} #${esc(p.collector_number)}</span><span>${esc(p.released_at?.slice(0, 4) || "")}</span></button>`).join("");
  }
  $("#crops").innerHTML = "";
  [["Name area", c.crops[0], c.raw.name], ["Set / number area", c.crops[1], c.raw.set]].forEach(([label, cv, r]) => {
    const div = document.createElement("div");
    div.innerHTML = `<b>${label}</b> <span class="hint">confidence ${Math.round(r.confidence)}%</span><br>`;
    div.append(cv); div.insertAdjacentHTML("beforeend", `<br><code>${esc(r.text.trim() || "(nothing)")}</code>`); $("#crops").append(div);
  });
  $("#crops").insertAdjacentHTML("beforeend", `<code>Name: ${esc(c.name || "–")} · Number: ${esc(c.info.num || "–")} · Set: ${esc(c.info.sets.join(", ") || "–")} · Language: ${esc(c.info.lang || "–")}</code>`);
}
$("#picker").addEventListener("click", ev => {
  const b = ev.target.closest("button[data-id]"); if (!b || !current?.res.prints) return;
  const card = current.res.prints.find(p => p.id === b.dataset.id);
  const how = current.res.how === "typed-choose" ? "typed" : "chosen";
  current.res = { ...current.res, card, how };
  addLog(card, how, current.ms.read + current.ms.lookup);
  renderResult(); status(`Chosen: ${card.name} (${card.set.toUpperCase()} #${card.collector_number})`, "ok");
});
function addLog(card, how, ms, what = "") {
  const m = current?.mode || (how === "typed" ? "–" : mode);
  log.unshift({ n: log.length + 1, name: card ? card.name : what, set: card ? card.set.toUpperCase() : "", cn: card ? card.collector_number : "", how, ms, mode: m });
  renderLog();
}
function renderLog() {
  $("#log").innerHTML = log.map(l => `<tr><td>${l.n}</td><td>${esc(l.name)}</td><td>${esc(l.set)}${l.cn ? " #" + esc(l.cn) : ""}</td><td>${tag(l.how)}</td><td>${esc(l.mode)}</td><td>${(l.ms / 1000).toFixed(1)} s</td></tr>`).join("");
  const line = (rows, label) => {
    const t = rows.length, count = k => rows.filter(l => HOW[l.how][0] === k).length, pct = n => ` (${Math.round(n * 100 / t)}%)`;
    return `<div>${label}<span>${t} scans</span> · <span>✔ automatic: ${count("exact")}${pct(count("exact"))}</span> · <span>✋ printing chosen: ${count("name")}${pct(count("name"))}</span> · ` +
      `<span>✖ not recognised: ${count("fail")}${pct(count("fail"))}</span> · <span>average ${(rows.reduce((s, l) => s + l.ms, 0) / t / 1000).toFixed(1)} s</span></div>`;
  };
  const m1 = log.filter(l => l.mode === 1), m2 = log.filter(l => l.mode === 2);
  $("#stats").innerHTML = !log.length ? `<span class="hint">Nothing yet.</span>`
    : (m1.length && m2.length) ? line(m1, "<b>Mode 1:</b> ") + line(m2, "<b>Mode 2:</b> ") + line(log, "<b>All:</b> ")
    : line(log, m2.length ? "<b>Mode 2:</b> " : m1.length ? "<b>Mode 1:</b> " : "");
}
$("#copyLog").onclick = async () => {
  const text = [...log].reverse().filter(l => l.set).map(l => `1 ${l.name} (${l.set}) ${l.cn}`).join("\n");
  try { await navigator.clipboard.writeText(text); $("#copyMsg").textContent = "Copied."; } catch { $("#copyMsg").textContent = "Copy failed."; }
};
$("#clearLog").onclick = () => { log = []; renderLog(); };
renderLog();

// typing a name: autocomplete, then the printing picker
let acTimer = 0;
$("#manualName").addEventListener("input", () => {
  clearTimeout(acTimer); const q = $("#manualName").value.trim(); if (q.length < 2) return;
  acTimer = setTimeout(async () => { const d = await sf("/cards/autocomplete?q=" + encodeURIComponent(q)).catch(() => null);
    $("#acList").innerHTML = (d?.data || []).map(n => `<option value="${esc(n)}">`).join(""); }, 250);
});
async function manualFind() {
  const q = $("#manualName").value.trim(); if (!q) return;
  status("Looking up on Scryfall…");
  const named = await sf("/cards/named?fuzzy=" + encodeURIComponent(q)).catch(() => null);
  if (!named) { status(`No card called “${q}”.`, "bad"); return; }
  const prints = await printsOf(named);
  current = current || { name: "", info: { num: "", sets: [], lang: "" }, raw: { name: { text: "", confidence: 0 }, set: { text: "", confidence: 0 } }, crops: [document.createElement("canvas"), document.createElement("canvas")], ms: { read: 0, lookup: 0 } };
  current.res = prints.length === 1 ? { card: prints[0], how: "typed" } : { card: null, how: "typed-choose", named, prints, suggested: new Set() };
  if (prints.length === 1) addLog(prints[0], "typed", 0);
  renderResult(); status(prints.length === 1 ? `Found: ${named.name}` : "Choose the printing you have.", prints.length === 1 ? "ok" : "warn");
}
$("#manualGo").onclick = manualFind;
$("#manualName").addEventListener("keydown", e => { if (e.key === "Enter") manualFind(); });

// ------------------------------------------------------------------ camera
async function startCamera(deviceId) {
  stopCamera();
  if (!window.isSecureContext) { status("The camera only works over HTTPS (or on localhost).", "bad"); return; }
  status("Starting the camera…");
  // zoom: true asks for zoom permission; Chrome only reports zoom in the camera's capabilities when it was requested
  const base = { width: { ideal: 3840 }, height: { ideal: 2160 }, zoom: true, advanced: [{ focusMode: "continuous" }] };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base, facingMode: { ideal: "environment" } } });
  } catch (err) {
    status(err.name === "NotAllowedError" ? "Camera permission was denied. Allow it in the browser's site settings." : "Could not start the camera: " + err.message, "bad"); return;
  }
  video.srcObject = stream; await video.play(); ctlTouched = false;
  source = "video"; still.hidden = true; video.hidden = false; $("#placeholder").hidden = true;
  stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  const track = stream.getVideoTracks()[0], caps = track.getCapabilities?.() || {};
  $("#camInfo").textContent = `Camera: ${video.videoWidth}×${video.videoHeight}.`;
  setupCamControls(track);
  // some phones report flashlight/focus/zoom only once the camera is delivering frames: check again shortly
  for (const ms of [700, 2000]) setTimeout(() => { if (stream?.getVideoTracks()[0] === track && !ctlTouched) setupCamControls(track); }, ms);
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
  const sel = $("#camSelect"); sel.innerHTML = cams.map((c, i) => `<option value="${esc(c.deviceId)}">${esc(c.label || "Camera " + (i + 1))}</option>`).join("");
  sel.value = track.getSettings().deviceId || ""; sel.hidden = cams.length < 2;
  $("#startCam").hidden = true; $("#stopCam").hidden = false; $("#capture").disabled = false;
  cardRect = null; pending = null; drawOverlay(); armed = true; prev = null; stillFor = 0;
  status("Hold a card in front of the camera.");
  getWorkers().then(() => status("Ready. Hold a card in front of the camera.")).catch(e => status("Text reader failed to load: " + e.message, "bad"));
}
function stopCamera() {
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  if (source === "video") { source = null; video.hidden = true; $("#placeholder").hidden = false; drawOverlay(); }
  $("#startCam").hidden = false; $("#stopCam").hidden = true; $("#camControls").hidden = true; $("#detailsRow").hidden = true; $("#camDump").hidden = true; $("#capture").disabled = !source;
}
$("#startCam").onclick = () => startCamera();
$("#stopCam").onclick = () => { stopCamera(); status(""); };
$("#camSelect").onchange = e => startCamera(e.target.value);
/* Flashlight, focus and zoom: only what the browser and camera allow (mostly Chrome on Android; some webcams in desktop Chrome).
   Unsupported controls are greyed out with a note, so it's clear it's the device, not the page. */
async function setTrack(c) {
  const track = stream?.getVideoTracks()[0]; if (!track) return false;
  try { await track.applyConstraints({ advanced: [c] }); return true; } catch (e) { status("The camera refused: " + (e.message || e.name), "warn"); return false; }
}
let ctlTouched = false;
function setupCamControls(track) {
  const caps = track.getCapabilities?.() || {}, set = track.getSettings?.() || {}, missing = [];
  $("#detailsRow").hidden = false;
  // flashlight
  const torch = $("#torch"); torch.hidden = !caps.torch; torch.dataset.on = ""; torch.textContent = "Flashlight";
  if (!caps.torch) missing.push("flashlight");
  // focus
  const fd = caps.focusDistance, canFocus = !!(fd && fd.max > fd.min && (caps.focusMode || []).includes("manual"));
  const f = $("#focus"), af = $("#autoFocus");
  $("#focusBox").hidden = !canFocus; af.checked = true; f.disabled = true;
  if (canFocus) {
    f.min = fd.min; f.max = fd.max; f.step = fd.step || (fd.max - fd.min) / 100;
    f.value = set.focusDistance ?? (fd.min + fd.max) / 2; showFocus();
  } else { $("#focusVal").textContent = ""; missing.push("focus"); }
  // zoom
  const z = caps.zoom, zr = $("#zoom"), canZoom = !!(z && z.max > z.min);
  $("#zoomBox").hidden = !canZoom;
  if (canZoom) { zr.min = z.min; zr.max = z.max; zr.step = z.step || 0.1; zr.value = set.zoom ?? z.min; $("#zoomVal").textContent = `${(+zr.value).toFixed(1)}×`; }
  else { $("#zoomVal").textContent = ""; missing.push("zoom"); }
  $("#camControls").hidden = missing.length === 3;   // show only what this camera allows
  $("#ctlNote").textContent = missing.length ? `Not available on this camera and browser: ${missing.join(", ")}.` : "";
}
function showFocus() { const v = +$("#focus").value; $("#focusVal").textContent = v >= 1 ? `${v.toFixed(2)} m` : `${Math.round(v * 100)} cm`; }
$("#torch").onclick = async () => { ctlTouched = true;
  const on = !$("#torch").dataset.on;
  if (await setTrack({ torch: on })) { $("#torch").dataset.on = on ? "1" : ""; $("#torch").textContent = on ? "Flashlight off" : "Flashlight"; }
};
$("#autoFocus").onchange = async () => { ctlTouched = true;
  const auto = $("#autoFocus").checked; $("#focus").disabled = auto;
  const modes = stream?.getVideoTracks()[0]?.getCapabilities?.().focusMode || [];
  if (auto) await setTrack({ focusMode: modes.includes("continuous") ? "continuous" : "single-shot" });
  else await setTrack({ focusMode: "manual", focusDistance: +$("#focus").value });
};
let focusTimer = 0;
$("#focus").oninput = () => { ctlTouched = true; showFocus(); clearTimeout(focusTimer);
  focusTimer = setTimeout(() => setTrack({ focusMode: "manual", focusDistance: +$("#focus").value }), 60); };
let zoomTimer = 0;
$("#zoom").oninput = () => { ctlTouched = true; $("#zoomVal").textContent = `${(+$("#zoom").value).toFixed(1)}×`; clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => setTrack({ zoom: +$("#zoom").value }), 60); };
$("#capture").onclick = () => scan("manual");
/** Raw camera information, to see what the browser actually offers. */
$("#camDetails").onclick = () => {
  const track = stream?.getVideoTracks()[0], pre = $("#camDump");
  const sup = navigator.mediaDevices.getSupportedConstraints?.() || {};
  const info = { browser: navigator.userAgent, camera: track?.label || "(camera not running)",
    browserSupports: Object.fromEntries(["torch", "focusMode", "focusDistance", "zoom", "exposureMode", "pointsOfInterest"].map(k => [k, !!sup[k]])),
    capabilities: track?.getCapabilities?.() || null, settings: track?.getSettings?.() || null };
  pre.textContent = JSON.stringify(info, null, 1); pre.hidden = false;
  navigator.clipboard?.writeText(pre.textContent).then(() => $("#ctlNote").textContent = "Camera details copied to the clipboard.", () => {});
};

// automatic capture: when the picture inside the outline has been still for ~0.6 s, and it changed since the last scan
const MIN_CARD_PX = 400;                          // card height in camera pixels needed to read the name
const STILL = 8;                                  // average brightness change per pixel (0–255) that still counts as "not moving"
let armed = true, prev = null, stillFor = 0, lastShot = null, goneFor = 0;
setInterval(() => {
  if (source !== "video" || !video.videoWidth) return;
  if (!busy) updateCard();
  drawOverlay();
  if (!cardRect) {                                  // no card: re-arm after ~1 s, so the same card can be scanned again
    prev = null; stillFor = 0; motion = null; diag();
    if (++goneFor >= 5 && !armed) { armed = true; status("Hold a card in front of the camera."); }
    return;
  }
  goneFor = 0;
  const t = thumb();
  motion = prev ? diff(t, prev) : null; prev = t; diag();
  if (!$("#auto").checked || busy) return;
  if (!armed) {
    if (lastShot && diff(t, lastShot) > 16) { armed = true; status("Hold the card still…"); }
    return;
  }
  if (cardRect.h < MIN_CARD_PX || detMiss > 0) { stillFor = 0; return; }   // too far away, or not seen in this frame   // too far away to read: the overlay says "Move the card closer"
  stillFor = motion !== null && motion < STILL ? stillFor + 1 : 0;
  if (stillFor >= 3) { armed = false; lastShot = t; stillFor = 0; scan("auto"); }
}, 200);

// ------------------------------------------------------------------ photo
$("#photoBtn").onclick = () => $("#photo").click();
$("#photo").onchange = async () => {
  const f = $("#photo").files[0]; $("#photo").value = ""; if (!f) return;
  stopCamera();
  still.src = URL.createObjectURL(f); await still.decode();
  const a = still.naturalWidth / still.naturalHeight;
  source = "photo"; still.style.objectFit = "cover";
  stage.style.aspectRatio = `${still.naturalWidth} / ${still.naturalHeight}`;
  video.hidden = true; still.hidden = false; $("#placeholder").hidden = true; $("#capture").disabled = false;
  await new Promise(r => requestAnimationFrame(r));
  cardRect = detectCard();                          // find the card in the photo first
  const cardShaped = Math.abs(a - CARD_RATIO) / CARD_RATIO < 0.12;
  if (cardRect && cardShaped && cardRect.w > still.naturalWidth * 0.85) cardRect = null;   // that's the frame inside a cropped card
  if (!cardRect && cardShaped) {                    // a photo of just the card
    source = "photoCard"; still.style.objectFit = "contain"; stage.style.aspectRatio = "16 / 9";
    await new Promise(r => requestAnimationFrame(r));
  }
  $("#camInfo").textContent = `Photo: ${still.naturalWidth}×${still.naturalHeight}, ` +
    (cardRect ? "card found in the picture." : source === "photoCard" ? "read as the whole card." : "no card edges found: reading inside the guide.");
  drawOverlay();
  scan("photo");
};
