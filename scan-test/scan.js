"use strict";
/* Card Scanner Test: standalone page.
   Camera -> card found in the picture -> white outline -> read the name bar and the bottom-left set/number line with Tesseract.js
   -> identify in the card index on the device: set code + collector number first, otherwise the name and a list of printings to pick from.
   No Scryfall lookups while scanning; only card pictures load from Scryfall's image server. */

const $ = s => document.querySelector(s);
const VERSION = "2026.10.04-5";                  // keep in step with index.html (meta app-version and scan.js?v=)
{ // version tag, top right; red if the page and the script come from different versions (old files in the browser cache)
  const page = (document.querySelector('meta[name="app-version"]')?.content || "").replace("scan-test ", ""), el = document.querySelector("#ver");
  el.textContent = "v" + VERSION;
  if (page !== VERSION) { el.classList.add("old"); el.textContent += ` (page ${page || "?"}: reload)`; }
}
const CARD_RATIO = 63 / 88;                       // width / height of a Magic card
// areas read, as fractions of the card (x, y, width, height)
/* Read areas, as fractions of the "read box": the found card plus room for the other interpretation of the outline
   (outer edge vs coloured frame), so the name bar and the set line are inside them either way. Each area holds a few
   lines of text; the reader picks the lines out. */
const ZONES = {
  name: { x: 0.03, y: 0.005, w: 0.80, h: 0.135, label: "name", px: 160 },
  set:  { x: 0.02, y: 0.830, w: 0.96, h: 0.170, label: "set · number", px: 300 },
};
const LANGS = ["EN", "DE", "FR", "IT", "ES", "PT", "JA", "KO", "RU", "ZHS", "ZHT", "PH"];
const abs = p => new URL(p, location.href).href;

const video = $("#video"), stage = $("#stage"), overlay = $("#overlay");
let stream = null, source = null;                 // source: "video" while the camera runs
let zoomCaps = null, curZoom = null;              // the camera's zoom range, and the zoom in use (null: can't zoom)
let workers = null, busy = false;
let log = [], current = null;

// ------------------------------------------------------------------ status
function status(msg, cls = "") { const s = $("#status"); s.textContent = msg; s.className = "status " + cls; }

/** Set codes the reader may find: the sets in the card index. */
const indexSets = () => IDX.data ? new Set([...IDX.data.sets.keys()].map(c => c.toUpperCase())) : new Set();


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
  const cam = source === "video" ? `${video.videoWidth}×${video.videoHeight}` : "off";
  el.textContent = `Text reader: ${readerState} · Card index: ${IDX.state} · Camera: ${cam}` + (boxActive() ? " · Box mode" : "") +
    ` · Sound: ${!$("#sound").checked ? "off" : "on, last: " + lastSound}` +
    (source === "video" ? ` · Card: ${cardRect ? `found (${Math.round(cardRect.h / video.videoHeight * 100)}% of picture height, edges ${Math.round(detCov * 100)}%${cardIsFrame ? ", from the coloured frame" : ""})` : "not found"} · Auto: ${autoWhy || "starting"}` : "") +
    (lastEvent ? ` · Last: ${lastEvent}` : "");
}
addEventListener("error", e => { status("Error: " + e.message, "bad"); lastEvent = "error"; diag(); });
addEventListener("unhandledrejection", e => { status("Error: " + (e.reason?.message || e.reason), "bad"); lastEvent = "error"; diag(); });

// ------------------------------------------------------------------ geometry
const srcSize = () => [video.videoWidth, video.videoHeight];
/** The white outline, in stage pixels. */
function outlineRect() {
  const W = stage.clientWidth, H = stage.clientHeight;
  let h = H * 0.8, w = h * CARD_RATIO;
  if (w > W * 0.85) { w = W * 0.85; h = w / CARD_RATIO; }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}
/** How the camera picture is drawn on the stage (object-fit: cover). */
function fit() {
  const [sw, sh] = srcSize(), W = stage.clientWidth, H = stage.clientHeight;
  const s = Math.max(W / sw, H / sh);
  return { s, ox: (W - sw * s) / 2, oy: (H - sh * s) / 2 };
}
const toStage = r => { const f = fit(); return { x: r.x * f.s + f.ox, y: r.y * f.s + f.oy, w: r.w * f.s, h: r.h * f.s }; };
const toSource = o => { const f = fit(); return { x: (o.x - f.ox) / f.s, y: (o.y - f.oy) / f.s, w: o.w / f.s, h: o.h / f.s }; };
/** The card area in source pixels: the detected card, else the guide outline. */
function cardRectInSource() {
  const [sw, sh] = srcSize();
  return cardRect || toSource(outlineRect());
}

// ------------------------------------------------------------------ finding the card in the picture
/* The picture is shrunk to 320 px wide; edges are found with a Sobel filter; long straight vertical and horizontal edges
   become candidate card sides, and the rectangle with a card's proportions whose sides are best covered by edges wins.
   Works for a card held roughly upright (up to about 5° tilt), at any distance and position. */
const DET_W = 320;
let cardRect = null, detMiss = 0, detCov = 0, cardAlt = null, cardIsFrame = false;
function detectCard(src = srcEl(), [sw, sh] = srcSize()) {
  if (!sw || !sh) return null;
  const W = DET_W, H = Math.max(40, Math.round(DET_W * sh / sw));
  const cv = detectCard.cv || (detectCard.cv = document.createElement("canvas"));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext("2d", { willReadFrequently: true }); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, W, H);
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
  const found = { x: best.L * k, y: best.T * k, w: (best.R - best.L) * k, h: (best.B - best.T) * k };
  // Outer edge or coloured frame? A black-bordered card on a dark background shows no outer edge, and the coloured
  // frame inside the border has almost a card's proportions. If just outside the rectangle is darker and more even
  // than just inside it, the rectangle is the frame: the card is the frame plus the black border.
  const stats = (x0, x1, y0, y1) => { let n = 0, s = 0, s2 = 0;
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) { const v = gray[y * W + x]; n++; s += v; s2 += v * v; }
    return n ? { n, mean: s / n, std: Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) } : { n: 0, mean: 0, std: 0 }; };
  const bw = Math.max(2, Math.round((best.R - best.L) * 0.035)), y0 = best.T + bw, y1 = best.B - bw;
  const merge = (a, b) => { const n = a.n + b.n; return n ? { n, mean: (a.mean * a.n + b.mean * b.n) / n, std: (a.std * a.n + b.std * b.n) / n } : a; };
  const inside = merge(stats(best.L + 1, best.L + bw, y0, y1), stats(best.R - bw, best.R - 1, y0, y1));
  const outside = merge(stats(best.L - bw, best.L - 1, y0, y1), stats(best.R + 1, best.R + bw, y0, y1));
  const isFrame = outside.n > 0 && outside.mean < 70 && outside.mean < inside.mean - 25 && outside.std < 22;
  const card = frameToCard(found);
  return isFrame ? { ...card, cov: best.cov, frame: true, alt: found } : { ...found, cov: best.cov, frame: false, alt: card };
}
/** The whole card from its coloured frame (modern frame: border about 4.5% of the width at the sides,
    3% of the height at the top and 8% at the bottom, where the set and number line is). */
const FRAME = { side: 0.045, top: 0.032, bottom: 0.079 };
function frameToCard(f) {
  const w = f.w / (1 - 2 * FRAME.side), h = f.h / (1 - FRAME.top - FRAME.bottom);
  return { x: f.x - FRAME.side * w, y: f.y - FRAME.top * h, w, h };
}
/** Track the card across frames: smooth small changes, jump to a new position only when it's seen twice. */
let pending = null;
function updateCard() {
  const r = boxActive() ? detectBoxCard() : detectCard();
  boxFull = !!r?.full;
  if (!r) { if (++detMiss > 3) { cardRect = null; cardAlt = null; detCov = 0; } return; }
  detMiss = 0; detCov = r.cov; cardAlt = r.alt; cardIsFrame = r.frame;
  const close = (a, b) => a && Math.abs(a.x - b.x) < b.w * 0.08 && Math.abs(a.y - b.y) < b.h * 0.08 && Math.abs(a.w - b.w) < b.w * 0.08;
  if (close(cardRect, r)) { const m = 0.5; cardRect = { x: cardRect.x + (r.x - cardRect.x) * m, y: cardRect.y + (r.y - cardRect.y) * m, w: cardRect.w + (r.w - cardRect.w) * m, h: cardRect.h + (r.h - cardRect.h) * m }; }
  else if (close(pending, r) || !cardRect) { cardRect = { x: r.x, y: r.y, w: r.w, h: r.h }; pending = null; }
  else pending = r;
}
function drawOverlay() {
  if (!source) { overlay.toggleAttribute("hidden", true); return; }
  overlay.toggleAttribute("hidden", false);   // an <svg> has no .hidden property
  const found = !!cardRect;
  const W = stage.clientWidth, H = stage.clientHeight, o = cardRect ? toStage(cardRect) : outlineRect(), r = o.w * 0.045;
  const rr = (x, y, w, h, r) => `M${x + r},${y}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - 2 * r}a${r},${r} 0 0 1 -${r},-${r}v-${h - 2 * r}a${r},${r} 0 0 1 ${r},-${r}z`;
  const bx = cardRect && cardAlt ? toStage(readBox(cardRect, cardAlt)) : o;
  const zone = z => { const x = bx.x + z.x * bx.w, y = bx.y + z.y * bx.h, w = z.w * bx.w, h = z.h * bx.h;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#fff" stroke-width="1.5" stroke-dasharray="5 4" opacity=".9"/>
      <text x="${z === ZONES.name ? x + 3 : x + w + 6}" y="${z === ZONES.name ? y + h + 13 : y + h / 2 + 4}" fill="#fff" font-size="12" font-family="system-ui" style="paint-order:stroke" stroke="#000" stroke-width="3">${z.label}</text>`; };
  const label = (t, y) => `<text x="${W / 2}" y="${y}" text-anchor="middle" fill="#fff" font-size="14" font-family="system-ui" style="paint-order:stroke" stroke="#000" stroke-width="3">${t}</text>`;
  const small = source === "video" && cardRect && cardRect.h < MIN_CARD_PX;
  const inBox = boxActive(), R = inBox ? toStage({ x: boxCal.region.x * video.videoWidth, y: boxCal.region.y * video.videoHeight, w: boxCal.region.w * video.videoWidth, h: boxCal.region.h * video.videoHeight }) : null;
  overlay.setAttribute("viewBox", `0 0 ${W} ${H}`);
  overlay.innerHTML = `<path d="M0,0H${W}V${H}H0Z ${rr(o.x, o.y, o.w, o.h, r)}" fill="rgba(0,0,0,${found ? .5 : .3})" fill-rule="evenodd"/>
    <path d="${rr(o.x, o.y, o.w, o.h, r)}" fill="none" stroke="#fff" stroke-width="${found ? 3 : 2}" ${found ? "" : 'stroke-dasharray="10 8" opacity=".8"'}/>` +
    (R ? `<rect x="${R.x}" y="${R.y}" width="${R.w}" height="${R.h}" fill="none" stroke="#5fd" stroke-width="1.5" stroke-dasharray="3 5"/>` : "") +
    (found ? zone(ZONES.name) + zone(ZONES.set) : label(inBox ? "Slide a card into the box" : "Hold a card in front of the camera", o.y + o.h / 2)) +
    (small ? label(inBox ? "Card too small: move the phone closer and recalibrate" : "Move the card closer", Math.min(H - 10, o.y + o.h + 20)) : "") +
    (inBox && boxFull ? label("The stack reaches the edge of the picture: empty the box", 20) : "");
}
new ResizeObserver(drawOverlay).observe(stage);

// ------------------------------------------------------------------ box mode
/* For scanning into a box with the phone held still above it. "Calibrate box" takes a picture of the empty box and
   learns its colour and where it is in the picture. After that the card is found as the part of the box area that
   isn't box colour (the box's inner walls frame it), which keeps working as the stack of cards grows towards the
   camera, and capture happens sooner because the picture is steadier. */
let boxCal = null;
try { boxCal = JSON.parse(localStorage.getItem("scanBox") || "null"); } catch {}
const boxZoomOk = () => boxCal?.zoom == null || curZoom == null || Math.abs(boxCal.zoom - curZoom) < 0.02;   // zooming moves the box in the picture
const boxActive = () => !!boxCal && source === "video" && boxCal.vw === video.videoWidth && boxCal.vh === video.videoHeight && boxZoomOk();
/** The camera picture shrunk to 320 px wide, as RGBA. */
function grabSmall() {
  const [sw, sh] = srcSize(), W = DET_W, H = Math.max(40, Math.round(DET_W * sh / sw));
  const cv = grabSmall.cv || (grabSmall.cv = document.createElement("canvas"));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext("2d", { willReadFrequently: true }); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  g.drawImage(srcEl(), 0, 0, W, H);
  return { W, H, d: g.getImageData(0, 0, W, H).data };
}
/** Colour without brightness (r, g, b shares), so shading on the box's walls doesn't change it. */
const chromaDist = (d, i, c) => { const s = d[i] + d[i + 1] + d[i + 2] + 1; return Math.abs(d[i] / s - c[0]) + Math.abs(d[i + 1] / s - c[1]) + Math.abs(d[i + 2] / s - c[2]); };
const brightness = (d, i) => (d[i] + d[i + 1] + d[i + 2]) / 3;
function calibrateBox() {
  if (source !== "video" || !video.videoWidth) { status("Start the camera first, with the empty box in view.", "warn"); return; }
  const { W, H, d } = grabSmall(), med = a => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];
  // the box colour: the middle of the picture, where the empty box should be
  const rs = [], gs = [], bs = [], ys = [];
  for (let y = Math.round(H * 0.3); y < H * 0.7; y++) for (let x = Math.round(W * 0.3); x < W * 0.7; x++) {
    const i = (y * W + x) * 4, s = d[i] + d[i + 1] + d[i + 2] + 1; if (s / 3 < 30) continue;
    rs.push(d[i] / s); gs.push(d[i + 1] / s); bs.push(d[i + 2] / s); ys.push(s / 3);
  }
  if (rs.length < 100) { status("The middle of the picture is too dark to calibrate. Add light and try again.", "bad"); return; }
  const c = [med(rs), med(gs), med(bs)], grey = Math.max(...c) - Math.min(...c) < 0.08, yMed = med(ys);
  const dists = []; for (let k = 0; k < rs.length; k++) dists.push(Math.abs(rs[k] - c[0]) + Math.abs(gs[k] - c[1]) + Math.abs(bs[k] - c[2]));
  const tol = Math.max(0.07, med(dists.slice()) * 4);
  // the box: the box-coloured area connected to the middle of the picture
  const isBox = i => brightness(d, i) > Math.min(35, yMed * 0.3) && chromaDist(d, i, c) < tol;
  const seen = new Uint8Array(W * H), stack = [(Math.round(H / 2)) * W + Math.round(W / 2)];
  let x0 = W, y0 = H, x1 = 0, y1 = 0, n = 0;
  while (stack.length) {
    const p = stack.pop(); if (seen[p]) continue; seen[p] = 1;
    if (!isBox(p * 4)) continue;
    const x = p % W, y = (p - x) / W; n++;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (x > 0) stack.push(p - 1); if (x < W - 1) stack.push(p + 1); if (y > 0) stack.push(p - W); if (y < H - 1) stack.push(p + W);
  }
  if (n < W * H * 0.05) { status("Couldn't find the box in the middle of the picture. Centre the empty box and try again.", "bad"); return; }
  boxCal = { c, tol, yMed, grey, region: { x: x0 / W, y: y0 / H, w: (x1 - x0 + 1) / W, h: (y1 - y0 + 1) / H }, vw: video.videoWidth, vh: video.videoHeight, zoom: curZoom, at: Date.now() };
  try { localStorage.setItem("scanBox", JSON.stringify(boxCal)); } catch {}
  cardRect = cardAlt = null; prev = null; stillFor = 0; armed = true; renderBox(); drawOverlay();
  status(grey ? "Box calibrated. Its colour is close to grey, so a brightly coloured box would work more reliably." : "Box calibrated. Slide a card in.", grey ? "warn" : "ok");
}
/** The card in box mode: the block of non-box-coloured pixels inside the box area. */
function detectBoxCard() {
  const { W, H, d } = grabSmall(), R = boxCal.region;
  const rx0 = Math.max(0, Math.floor((R.x - 0.02) * W)), rx1 = Math.min(W - 1, Math.ceil((R.x + R.w + 0.02) * W));
  const ry0 = Math.max(0, Math.floor((R.y - 0.02) * H)), ry1 = Math.min(H - 1, Math.ceil((R.y + R.h + 0.02) * H));
  const dark = Math.min(35, boxCal.yMed * 0.3), rw = rx1 - rx0 + 1, rh = ry1 - ry0 + 1;
  const card = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const i = ((y + ry0) * W + x + rx0) * 4;
    card[y * rw + x] = brightness(d, i) <= dark || chromaDist(d, i, boxCal.c) >= boxCal.tol ? 1 : 0;
  }
  const run = (vals, thr) => {                        // longest run above thr, allowing 2-pixel gaps
    let best = null, start = -1, gap = 0;
    for (let k = 0; k <= vals.length; k++) {
      if (k < vals.length && vals[k] > thr) { if (start < 0) start = k; gap = 0; }
      else if (start >= 0 && (++gap > 2 || k === vals.length)) { const e = k - gap; if (!best || e - start > best[1] - best[0]) best = [start, e]; start = -1; gap = 0; }
    }
    return best;
  };
  const rows = []; for (let y = 0; y < rh; y++) { let s = 0; for (let x = 0; x < rw; x++) s += card[y * rw + x]; rows.push(s / rw); }
  const ry = run(rows, 0.4); if (!ry || ry[1] - ry[0] < rh * 0.2) return null;
  const cols = []; for (let x = 0; x < rw; x++) { let s = 0; for (let y = ry[0]; y <= ry[1]; y++) s += card[y * rw + x]; cols.push(s / (ry[1] - ry[0] + 1)); }
  const rx = run(cols, 0.5); if (!rx) return null;
  const w = rx[1] - rx[0] + 1, h = ry[1] - ry[0] + 1;
  if (Math.abs(w / h - CARD_RATIO) / CARD_RATIO > 0.18) return null;   // not card-shaped (a hand, or the card is still sliding)
  let fill = 0; for (let y = ry[0]; y <= ry[1]; y++) for (let x = rx[0]; x <= rx[1]; x++) fill += card[y * rw + x];
  fill /= w * h; if (fill < 0.75) return null;
  const k = srcSize()[0] / W;
  return { x: (rx[0] + rx0) * k, y: (ry[0] + ry0) * k, w: w * k, h: h * k, cov: fill, frame: false, alt: null,
    full: rx[0] + rx0 <= 1 || rx[1] + rx0 >= W - 2 || ry[0] + ry0 <= 1 || ry[1] + ry0 >= H - 2 };
}
let boxFull = false;
function renderBox() {
  const on = boxActive();
  $("#boxOff").hidden = !boxCal;
  $("#calib").textContent = boxCal ? "Recalibrate box" : "Calibrate box";
  $("#boxNote").textContent = !boxCal ? "" : on ? `Box mode on (calibrated ${new Date(boxCal.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`
    : source === "video" ? (!boxZoomOk() && boxCal.vw === video.videoWidth && boxCal.vh === video.videoHeight
        ? `Box calibrated at zoom ${(+boxCal.zoom).toFixed(2)}×: set that zoom again, or recalibrate` : "Box calibrated with another camera or resolution: recalibrate") : "Box mode on";
}
$("#calib").onclick = () => calibrateBox();
$("#idxCheck").onclick = () => checkIndex(false);
$("#idxForce").onclick = () => checkIndex(true);
renderBox();
$("#boxOff").onclick = () => { boxCal = null; try { localStorage.removeItem("scanBox"); } catch {} cardRect = cardAlt = null; renderBox(); drawOverlay(); status("Box mode off."); };

// ------------------------------------------------------------------ image processing
const srcEl = () => video;
/** Cut a zone out of the card, scaled so the text is a good size for the reader, as dark text on a light background. */
function zoneCanvas(z, src = srcEl(), c = cardRectInSource()) {
  return stripCanvas(src, c.x + z.x * c.w, c.y + z.y * c.h, z.w * c.w, z.h * c.h, z.px);
}
/** Box blur of a grayscale image (radius r), via running sums: horizontal then vertical. */
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0; const row = y * w;
    for (let x = -r; x <= r; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) { tmp[row + x] = s / (2 * r + 1); s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = s / (2 * r + 1); s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
  }
  return out;
}
/** Cut out a strip of the picture, scale it to height dh, and make it dark text on a light background.
    "local" (default) compares every pixel with its own surroundings, so glare, shadows and dim light across the strip
    don't wash the letters out; "global" stretches the contrast of the whole strip at once (used as a second try). */
function stripCanvas(src, sx, sy, sw, sh, dh, how = "local", text = "auto") {
  const dw = Math.max(8, Math.round(dh * sw / sh)), pad = 14;
  const cv = document.createElement("canvas"); cv.width = dw + 2 * pad; cv.height = dh + 2 * pad;
  const g = cv.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high";
  g.drawImage(src, sx, sy, sw, sh, pad, pad, dw, dh);
  const im = g.getImageData(pad, pad, dw, dh), d = im.data, n = dw * dh, gray = new Float32Array(n);
  for (let i = 0; i < n; i++) gray[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
  const pctOf = (arr, ps) => { const s = Float32Array.from(arr).sort(); return ps.map(p => s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
  let out;
  if (how === "local") {
    const sm = boxBlur(gray, dw, dh, 1);                                       // a little smoothing against sensor noise
    const bgr = boxBlur(sm, dw, dh, Math.max(4, Math.round(Math.min(dh, 70) * 0.45)));   // the local background
    const hp = new Float32Array(n); for (let i = 0; i < n; i++) hp[i] = sm[i] - bgr[i];
    const [lo, hi] = pctOf(hp, [0.02, 0.98]);
    const t = new Float32Array(n), dark = text === "dark" ? true : text === "light" ? false : -lo >= hi;   // the text is the stronger tail, unless told
    for (let i = 0; i < n; i++) t[i] = dark ? -hp[i] : hp[i];
    const [nf, top] = pctOf(t, [0.6, 0.985]), span = Math.max(top - nf, 4);
    out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = 255 - Math.min(1, Math.max(0, (t[i] - nf) / span)) * 255;
  } else {
    const [lo, hi, med] = pctOf(gray, [0.03, 0.97, 0.5]), span = Math.max(hi - lo, 1), invert = med < (lo + hi) / 2;
    out = new Float32Array(n); for (let i = 0; i < n; i++) { let v = (gray[i] - lo) * 255 / span; v = v < 0 ? 0 : v > 255 ? 255 : v; out[i] = invert ? 255 - v : v; }
  }
  for (let i = 0; i < n; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = out[i]; d[i * 4 + 3] = 255; }
  // erase solid horizontal bars (frame edges caught at the strip's top or bottom): rows that are mostly dark
  for (let y = 0; y < dh; y++) {
    let dk = 0; for (let x = 0; x < dw; x++) if (d[(y * dw + x) * 4] < 110) dk++;
    if (dk > dw * 0.55) for (let x = 0; x < dw; x++) { const k = (y * dw + x) * 4; d[k] = d[k + 1] = d[k + 2] = 255; }
  }
  g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height);
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
/** Name candidates from the name area, top line first (the area may also catch a bit of the art below the name bar). */
function nameLines(t) {
  return t.split(/\r?\n/).map(cleanName).filter(l => (l.match(/[A-Za-zÀ-ÿ]/g) || []).length >= 3).slice(0, 3);
}
const CONFUSE = { "0": "O", "O": "0", "1": "I", "I": "1", "5": "S", "S": "5", "8": "B", "B": "8", "2": "Z", "Z": "2" };
function setVariants(tok) {
  const out = new Set([tok]);
  for (let i = 0; i < tok.length; i++) if (CONFUSE[tok[i]]) out.add(tok.slice(0, i) + CONFUSE[tok[i]] + tok.slice(i + 1));
  return [...out];
}
/** Collector number, set code candidates (checked against the sets in the card index) and language from the bottom-left line. */
function parseSetLine(t, codes) {
  const text = t.toUpperCase().replace(/[•·*]/g, " • ");
  // the copyright year ("™ & © 2024 Wizards of the Coast") isn't a collector number
  const noYear = text.replace(/(©|@|\(C\))\s*(19|20)\d\d/g, " ").replace(/(19|20)\d\d\s*WIZARD/g, " ");
  const nums = [...noYear.matchAll(/(?:^|\s)0*(\d{1,4})(?:\s*\/\s*\d{1,4})?(?=\s|$)/gm)].map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i);
  const num = nums[0] || "";
  const toks = text.split(/[^A-Z0-9]+/).filter(Boolean);
  let lang = "", sets = [], unknown = "";
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (LANGS.includes(tok) && i > 0) lang ||= tok.toLowerCase();
    if (tok.length < 3 || tok.length > 5 || /^\d+$/.test(tok)) continue;
    const followedByLang = LANGS.includes(toks[i + 1] || "");
    const hit = setVariants(tok).find(v => codes.has(v));
    if (hit) { if (followedByLang) sets.unshift(hit); else sets.push(hit); }
    else if (followedByLang && /[A-Z]/.test(tok)) unknown ||= tok;        // looks like a set code, but not one in the card index
  }
  return { num, nums, sets: [...new Set(sets)].slice(0, 4), lang, unknown: sets.length ? "" : unknown };
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

// ------------------------------------------------------------------ finding text lines in an area
/** Horizontal bands of text in an area: rows with many light/dark changes along them (letters), between calmer rows.
    Returns bands as fractions of the area height, top to bottom. */
function textBands(src, r) {
  const W = 360, H = Math.max(12, Math.round(W * r.h / r.w));
  const cv = textBands.cv || (textBands.cv = document.createElement("canvas")); cv.width = W; cv.height = H;
  const g = cv.getContext("2d", { willReadFrequently: true }); g.imageSmoothingQuality = "high";
  g.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data, E = new Float32Array(H), x0 = Math.round(W * 0.03), x1 = Math.round(W * 0.97);
  for (let y = 0; y < H; y++) {
    let e = 0, prev = -1;
    for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4, v = (d[i] + d[i + 1] + d[i + 2]) / 3; if (prev >= 0) e += Math.abs(v - prev); prev = v; }
    E[y] = e / (x1 - x0);
  }
  const S = E.map((_, y) => (E[Math.max(0, y - 1)] + E[y] + E[Math.min(H - 1, y + 1)]) / 3);
  const sorted = [...S].sort((a, b) => a - b), lo = sorted[Math.floor(H * 0.2)], hi = sorted[H - 1];
  const T = lo + 0.3 * (hi - lo), bands = [];
  for (let y = 0; y < H; y++) {
    if (S[y] <= T) continue;
    const last = bands[bands.length - 1];
    if (last && y - last[1] <= 2) last[1] = y; else bands.push([y, y]);
  }
  return bands.filter(b => b[1] - b[0] >= 2).map(([a, b]) => ({ y0: a / H, y1: (b + 1) / H }));
}
/** Read the name: try the text lines in the name area from the top, keep the first that reads as a name. */
async function readName(w, snap) {
  const box = snap.box, z = ZONES.name, r = { x: box.x + z.x * box.w, y: box.y + z.y * box.h, w: z.w * box.w, h: z.h * box.h };
  const cardH = Math.min(snap.rect.h, snap.alt ? snap.alt.h : Infinity);
  const bands = textBands(snap.cv, r).filter(b => { const h = (b.y1 - b.y0) * r.h / cardH; return h > 0.012 && h < 0.07; }).slice(0, 3);
  const tries = [];
  const good = t => t.names.length && t.data.confidence >= 55;
  for (const how of ["local", "global"]) {           // second pass with the other contrast correction, only if needed
    for (const b of bands) {
      const bh = (b.y1 - b.y0) * r.h, y = r.y + b.y0 * r.h - bh * 0.35;
      const cv = stripCanvas(snap.cv, r.x, y, r.w, bh * 1.7, 64, how);
      const out = await w.name.recognize(cv), names = nameLines(out.data.text);
      tries.push({ cv, data: out.data, names });
      if (good(tries[tries.length - 1])) break;
    }
    if (tries.some(good)) break;
  }
  if (!tries.length) {                              // no lines found: read the whole area
    const cv = zoneCanvas(ZONES.name, snap.cv, box), out = await w.name.recognize(cv);
    tries.push({ cv, data: out.data, names: nameLines(out.data.text) });
  }
  const pick = tries.find(t => t.names.length && t.data.confidence >= 55) || tries.filter(t => t.names.length).sort((a, b) => b.data.confidence - a.data.confidence)[0] || tries[0];
  const names = [...new Set([...pick.names, ...tries.flatMap(t => t.names)])].slice(0, 3);
  return { names, cv: pick.cv, data: pick.data };
}
/** Read the set line. First the whole bottom area at once (numbers, set code and language are picked out wherever they
    are; the artist and copyright text are ignored), then line by line if needed. A set code + number pair that exists in
    the card index wins; the read texts are combined for that. */
async function readSet(w, snap, codes) {
  const box = snap.box, z = ZONES.set, r = { x: box.x + z.x * box.w, y: box.y + z.y * box.h, w: z.w * box.w, h: z.h * box.h };
  const cardH = Math.min(snap.rect.h, snap.alt ? snap.alt.h : Infinity), D = IDX.data;
  const numVariants = n => [n, n.length >= 3 ? n.slice(0, -1) : ""].filter(Boolean);   // a rarity letter read as a digit
  const pairIn = info => { if (!D) return null;
    for (const set of info.sets) for (const n of info.nums || []) for (const v of numVariants(n))
      if (D.bySetCn.has(`${set.toLowerCase()}|${normCn(v)}`)) return { set, num: v };
    return null; };
  const tries = [];
  const read = async (cv) => { const out = await w.set.recognize(cv), info = parseSetLine(out.data.text, codes); const t = { cv, data: out.data, info }; tries.push(t); return t; };
  // 1. the whole area; the collector line is usually light text on the black border, so look at the bottom's brightness
  const bottom = (() => { const c = document.createElement("canvas"); c.width = 40; c.height = 8; const g = c.getContext("2d");
    g.drawImage(snap.cv, r.x, r.y + r.h * 0.6, r.w, r.h * 0.4, 0, 0, 40, 8); const d = g.getImageData(0, 0, 40, 8).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4) / 3; })();
  const textTone = bottom < 110 ? "light" : "auto";
  const linesInArea = Math.max(2, Math.round(r.h / cardH / 0.03));            // about how many text lines fit in the area
  let t = await read(stripCanvas(snap.cv, r.x, r.y, r.w, r.h, Math.min(420, 34 * linesInArea), "local", textTone));
  // 2. line by line, bottom first, only if the whole-area read didn't give an existing set + number
  if (!pairIn(t.info)) {
    const bands = textBands(snap.cv, r).filter(b => { const h = (b.y1 - b.y0) * r.h / cardH; return h > 0.006 && h < 0.05; });
    const cands = [];
    for (let i = bands.length - 1; i >= 0 && cands.length < 3; i--) {
      const b = bands[i], prev = bands[i - 1], bh = b.y1 - b.y0;
      if (prev && b.y0 - prev.y1 < bh * 2.5) cands.push({ y0: prev.y0, y1: b.y1, lines: 2 });   // two lines together
      cands.push({ y0: b.y0, y1: b.y1, lines: 1 });
    }
    outer: for (const how of ["local", "global"]) {
      for (const c of cands.slice(0, 3)) {
        const bh = (c.y1 - c.y0) * r.h, y = r.y + c.y0 * r.h - bh * 0.25 / c.lines;
        const tt = await read(stripCanvas(snap.cv, r.x, y, r.w, bh * (1 + 0.5 / c.lines), c.lines === 2 ? 120 : 60, how));
        if (pairIn(tt.info)) break outer;
      }
      if (tries.some(x => x.info.sets.length)) break;
    }
  }
  // combine everything read: all set codes (those next to a language code first) and all numbers
  const sets = [...new Set(tries.flatMap(x => x.info.sets))], nums = [...new Set(tries.flatMap(x => x.info.nums || []))];
  const lang = tries.map(x => x.info.lang).find(Boolean) || "", unknown = sets.length ? "" : tries.map(x => x.info.unknown).find(Boolean) || "";
  const merged = { sets, nums, num: nums[0] || "", lang, unknown };
  const pair = pairIn(merged);
  if (pair) { merged.sets = [pair.set, ...sets.filter(x => x !== pair.set)]; merged.num = pair.num; merged.nums = [pair.num, ...nums.filter(x => x !== pair.num)]; merged.checked = true; }
  const score = x => (pairIn(x.info) ? 4 : 0) + (x.info.sets.length ? 2 : 0) + (x.info.num ? 1 : 0);
  const shown = tries.slice().sort((a, b) => score(b) - score(a))[0];
  return { cv: shown.cv, data: shown.data, info: merged };
}

// ------------------------------------------------------------------ local card index
/* A compact list of every printing (built from Scryfall's bulk data by tools/build_card_index.py, see data/version.json),
   downloaded once and kept in the browser's IndexedDB. All lookups run on the device; nothing is asked from Scryfall
   while scanning. */
const IDX = { state: "not loaded", data: null, version: null };
function idbOpen() {
  return new Promise((res, rej) => { const r = indexedDB.open("cardScanner", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function idbGet(k) { const db = await idbOpen(); return new Promise((res, rej) => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function idbSet(k, v) { const db = await idbOpen(); return new Promise((res, rej) => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
const fmtN = n => n.toLocaleString("en-US");
/** Load the card index: the stored copy if it's current, else download it. force: download even if current.
    Returns "current", "updated", "offline" (couldn't check, using the stored copy) or "failed". */
async function loadIndex(force = false) {
  IDX.state = "checking…"; diag();
  let ver = null, stored = null;
  try { const r = await fetch(abs("data/version.json"), { cache: "no-cache" }); if (r.ok) ver = await r.json(); } catch {}
  try { stored = await idbGet("index"); } catch {}
  let text = null, v = null;
  let result = "current";
  if (stored?.text && (!ver || (stored.sha === ver.sha && !force))) { text = stored.text; v = stored.version; if (!ver) result = "offline"; }   // up to date (or offline: use what we have)
  else if (ver) {
    try {
      const r = await fetch(abs(`data/cards.txt.gz?v=${ver.sha}`)); if (!r.ok) throw new Error("HTTP " + r.status);
      const reader = r.body.getReader(), parts = []; let got = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length;
        IDX.state = `downloading ${Math.min(99, Math.round(got * 100 / (ver.bytes || got)))}% of ${(ver.bytes / 1e6).toFixed(1)} MB`; diag(); }
      const blob = new Blob(parts), head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
      text = head[0] === 0x1f && head[1] === 0x8b ? await new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text() : await blob.text();
      v = ver; result = "updated";
      try { await idbSet("index", { sha: ver.sha, version: ver, text }); } catch {}   // can't store: use it for this visit only
    } catch (e) { if (stored?.text) { text = stored.text; v = stored.version; result = "failed"; } else { IDX.state = "download failed: cards can't be identified until it loads"; diag(); return "failed"; } }
  } else { IDX.state = "not available: cards can't be identified until it loads"; diag(); return "failed"; }
  if (result !== "current" || !IDX.data) { IDX.data = parseIndex(text); IDX.version = v; }
  IDX.state = `${fmtN(IDX.data.n)} printings, ${(v?.source_updated || v?.built || "").slice(0, 10)}`; diag();
  return result;
}
/** "Check for card index update" (and "Download again"): ask the site for the current index version now. */
async function checkIndex(force) {
  const b1 = $("#idxCheck"), b2 = $("#idxForce"); b1.disabled = b2.disabled = true;
  const before = IDX.version?.sha;
  const r = await loadIndex(force).catch(() => "failed");
  b1.disabled = b2.disabled = false;
  const date = (IDX.version?.source_updated || IDX.version?.built || "").slice(0, 10);
  $("#idxMsg").textContent = r === "updated" ? (IDX.version?.sha === before ? `Downloaded again (cards from ${date}).` : `Updated: cards from ${date}, ${fmtN(IDX.data.n)} printings.`)
    : r === "current" ? `Already up to date (cards from ${date}).` : r === "offline" ? "Couldn't reach the site; using the stored index." : "Couldn't download the index.";
}
const normName = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9぀-鿿가-힯]/g, "");
const normCn = cn => String(cn).toLowerCase().replace(/^0+(?=\d)/, "");
function parseIndex(text) {
  const sets = new Map(), id = [], set = [], cn = [], lang = [], fin = [], name = [], printed = [];
  let mode = "";
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line[0] === "#") { mode = line; continue; }
    const f = line.split("|");
    if (mode === "#sets") sets.set(f[0], { name: f[1], released: f[2] });
    else { id.push(f[0]); set.push(f[1]); cn.push(f[2]); lang.push(f[3]); fin.push(f[4]); name.push(f[5]); printed.push(f[6] || ""); }
  }
  const bySetCn = new Map(), byName = new Map(), buckets = new Map();
  const add = (m, k, i) => { const a = m.get(k); if (a) a.push(i); else m.set(k, [i]); };
  for (let i = 0; i < id.length; i++) {
    add(bySetCn, `${set[i]}|${normCn(cn[i])}`, i);
    const keys = new Set([name[i], ...name[i].split(" // "), ...(printed[i] ? [printed[i], ...printed[i].split(" // ")] : [])].map(normName).filter(Boolean));
    for (const k of keys) add(byName, k, i);
  }
  for (const k of byName.keys()) add(buckets, k.length, k);
  return { n: id.length, sets, id, set, cn, lang, fin, name, printed, bySetCn, byName, buckets };
}
/** A printing from the index, shaped like a Scryfall card object (image addresses follow from the id). */
function printingOf(i) {
  const D = IDX.data, h = D.id[i], uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  const img = size => `https://cards.scryfall.io/${size}/front/${uuid[0]}/${uuid[1]}/${uuid}.jpg`;
  const s = D.sets.get(D.set[i]) || {};
  return { id: uuid, name: D.name[i], printed_name: D.printed[i] || undefined, set: D.set[i], set_name: s.name || D.set[i].toUpperCase(),
    collector_number: D.cn[i], lang: D.lang[i], released_at: s.released || "", finishes: D.fin[i],
    image_uris: { small: img("small"), normal: img("normal") }, uri: `https://scryfall.com/card/${D.set[i]}/${encodeURIComponent(D.cn[i])}`, local: true };
}
/** Edit distance, giving up (returning max + 1) once it can't stay within max. */
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j), cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i; let rowMin = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (cur[j] < rowMin) rowMin = cur[j]; }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}
/** Closest card name to the text read: tries the whole line and parts of it (junk letters from the frame or the
    mana cost at either end), allowing about 1 wrong letter in 4. */
function localName(line) {
  const D = IDX.data, words = line.split(/\s+/).filter(Boolean);
  let best = null;
  for (let a = 0; a < words.length; a++) for (let b = words.length; b > a; b--) {
    const dropped = a + words.length - b; if (dropped > 2) continue;
    const q = normName(words.slice(a, b).join(" ")); if (q.length < 3) continue;
    const kept = q.length / Math.max(1, normName(line).length); if (kept < 0.6) continue;   // keep most of what was read
    const pen = dropped ? 0.02 + 0.08 * (1 - kept) : 0;                                         // dropping words costs a little
    if (D.byName.has(q)) { const r = { key: q, sim: 1 - pen }; if (!best || r.sim > best.sim) best = r; continue; }
    const maxD = Math.max(1, Math.round(q.length * 0.3)); let bk = null, bd = maxD + 1;
    for (let len = q.length - maxD; len <= q.length + maxD; len++) for (const k of D.buckets.get(len) || []) { const d = lev(q, k, bd - 1 < 0 ? 0 : Math.min(maxD, bd)); if (d < bd) { bd = d; bk = k; } }
    if (bk) { const r = { key: bk, sim: 1 - bd / Math.max(q.length, bk.length) - pen, len: q.length }; if (!best || r.sim > best.sim) best = r; }
  }
  return best && best.sim >= (best.len && best.len < 6 ? 0.75 : 0.7) ? best : null;
}
/** Identify in the card index. */
function localIdentify(names, info) {
  const D = IDX.data; if (!D) return { card: null, how: "fail", why: "noindex" };
  const lang = info.lang || "en";
  // how well a read name agrees with a real one: overall similarity, or (for a name partly hidden by glare) how much of
  // what was read appears unbroken in the real name
  const agree = (read, real) => {
    const a = normName(read), b = normName(real); let best = 0;
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) { let k = 0; while (a[i + k] && a[i + k] === b[j + k]) k++; if (k > best) best = k; }
    return Math.max(similarity(read, real), a.length >= 5 ? 0.9 * best / a.length : 0);
  };
  const nameSim = i => Math.max(0, ...names.flatMap(n => [D.name[i], ...D.name[i].split(" // "), D.printed[i]].filter(Boolean).map(x => agree(n, x))));
  // collector number as read, and without its last digit (the rarity letter is often misread as a digit: "0263 U" -> "02630")
  const nums = info.num ? [...new Set([normCn(info.num), info.num.length >= 3 ? normCn(info.num.slice(0, -1)) : ""].filter(Boolean))] : [];
  // 1. set code + collector number
  for (const code of info.sets) for (const num of nums) {
    const hits = D.bySetCn.get(`${code.toLowerCase()}|${num}`) || [];
    const i = hits.find(i => D.lang[i] === lang) ?? hits[0];
    if (i != null && (!names.length || nameSim(i) >= 0.55)) return { card: printingOf(i), how: "set+number", nameUsed: names[0] };
  }
  // 2. the name, narrowed down by whatever set code or number was read
  for (const n of names) {
    const m = localName(n); if (!m) continue;
    const idx = D.byName.get(m.key).slice().sort((a, b) => (D.sets.get(D.set[b])?.released || "").localeCompare(D.sets.get(D.set[a])?.released || ""));
    const prints = idx.map(printingOf);
    const bySet = info.sets.length ? prints.filter(p => info.sets.includes(p.set.toUpperCase())) : [];
    const pool = bySet.length ? bySet : prints;
    const byNum = nums.length ? pool.filter(p => nums.includes(normCn(p.collector_number))) : [];
    const r = { nameUsed: n };
    if (byNum.length === 1) return { ...r, card: byNum[0], how: bySet.length ? "name+set+number" : "name+number" };
    if (bySet.length === 1) return { ...r, card: bySet[0], how: "name+set" };
    // only the name, and it's the card's only printing: accepted only when the name was read clearly, and the set code
    // read (if any) is one the index knows; otherwise you confirm it
    if (prints.length === 1 && !info.unknown && m.sim >= 0.85) return { ...r, card: prints[0], how: "name (one printing)" };
    return { ...r, card: null, how: "choose", named: prints[0], prints, suggested: new Set((byNum.length ? byNum : bySet).map(p => p.id)), unknown: info.unknown };
  }
  return { card: null, how: "fail", unknown: info.unknown };
}

// ------------------------------------------------------------------ one scan
/** Copy of the card area of the current frame, so reading isn't affected by the picture changing. */
/** The box the read areas are placed in: the found card united with its other interpretation. */
function readBox(r, a) {
  if (!a) return r;
  const x0 = Math.min(r.x, a.x), y0 = Math.min(r.y, a.y);
  return { x: x0, y: y0, w: Math.max(r.x + r.w, a.x + a.w) - x0, h: Math.max(r.y + r.h, a.y + a.h) - y0 };
}
function snapshotCard(src = srcEl(), [sw, sh] = srcSize(), r = cardRectInSource(), a = cardRect && cardAlt ? cardAlt : null, frame = cardIsFrame) {
  const ux0 = Math.min(r.x, a ? a.x : r.x), uy0 = Math.min(r.y, a ? a.y : r.y);
  const ux1 = Math.max(r.x + r.w, a ? a.x + a.w : 0), uy1 = Math.max(r.y + r.h, a ? a.y + a.h : 0);
  const x = Math.max(0, Math.floor(ux0)), y = Math.max(0, Math.floor(uy0));
  const w = Math.max(1, Math.min(sw, Math.ceil(ux1)) - x), h = Math.max(1, Math.min(sh, Math.ceil(uy1)) - y);
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  cv.getContext("2d").drawImage(src, x, y, w, h, 0, 0, w, h);
  const rel = q => ({ x: q.x - x, y: q.y - y, w: q.w, h: q.h });
  return { cv, rect: rel(r), alt: a ? rel(a) : null, box: rel(readBox(r, a)), frame };
}
/* Mode 3: if the video frame doesn't give a result, take a real photo with the camera (ImageCapture.takePhoto, mostly
   Chrome on Android): much higher resolution and the phone's still-photo processing, at the cost of 0.5-1.5 s. */
const photoSupported = () => "ImageCapture" in window && !!stream?.getVideoTracks()[0];
let imageCap = null, imageCapTrack = null;
async function photoSnapshot() {
  const track = stream?.getVideoTracks()[0]; if (!track || !("ImageCapture" in window)) return null;
  if (imageCapTrack !== track) {
    imageCap = new ImageCapture(track); imageCapTrack = track; imageCap.settings = {};
    try {                                            // the largest photo the camera offers, and no flash
      const pc = await imageCap.getPhotoCapabilities();
      if (pc.imageWidth?.max) Object.assign(imageCap.settings, { imageWidth: pc.imageWidth.max, imageHeight: pc.imageHeight?.max });
      if ((pc.fillLightMode || []).includes("off")) imageCap.settings.fillLightMode = "off";
    } catch {}
  }
  const t = performance.now();
  let blob;
  try { blob = await imageCap.takePhoto(imageCap.settings); } catch { blob = await imageCap.takePhoto(); }   // some cameras refuse settings
  const bmp = await createImageBitmap(blob);
  const P = [bmp.width, bmp.height], [vw, vh] = srcSize(), sameShape = Math.abs(P[0] / P[1] - vw / vh) < 0.02;
  // where's the card in the photo? Box mode: the same place as in the video (the camera doesn't move); otherwise find it again
  let r = null, a = null, frame = false;
  if (!(boxActive() && sameShape)) {
    const d = detectCard(bmp, P);
    if (d && (!sameShape || !cardRect || Math.abs(d.x / P[0] - cardRect.x / vw) < 0.05)) { r = { x: d.x, y: d.y, w: d.w, h: d.h }; a = d.alt; frame = d.frame; }
  }
  if (!r && sameShape && cardRect) {               // same framing as the video: scale the video outline up
    const k = P[0] / vw, sc = q => q && { x: q.x * k, y: q.y * k, w: q.w * k, h: q.h * k };
    r = sc(cardRect); a = sc(cardAlt); frame = cardIsFrame;
  }
  if (!r) { bmp.close?.(); return { ms: performance.now() - t, size: P, failed: "card not found in the photo" }; }
  const snap = snapshotCard(bmp, P, r, a, frame);
  bmp.close?.();
  return Object.assign(snap, { ms: performance.now() - t, size: P });
}
/** Sharpness of the two read areas: variance of the Laplacian (higher = sharper edges). */
function sharpness(snap) {
  let total = 0;
  for (const z of [ZONES.name, ZONES.set]) {
    const c = snap.box, sx = c.x + z.x * c.w, sy = c.y + z.y * c.h, sw = z.w * c.w, sh = z.h * c.h;
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
let mode = (() => { try { return [1, 2, 3, 4].includes(+localStorage.getItem("scanMode")) ? +localStorage.getItem("scanMode") : 1; } catch { return 1; } })();
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
    if (!workers) status("Waiting for the text reader to load…");
    const w = await getWorkers();
    status("Reading…");
    const codes = indexSets();
    const readSnap = async sn => {
      const [nm, st] = await Promise.all([readName(w, sn), readSet(w, sn, codes)]);
      const names = nm.names, info = st.info;
      return { nm, st, names, name: names[0] || "", info, res: names.length || info.num ? localIdentify(names, info) : null };
    };
    const rank = r => !r ? -1 : r.card ? 2 : r.how === "choose" ? 1 : 0;
    let R = null, used = snap.frame ? "frame + border" : "outer edge", photoNote = "";
    const tryPhoto = async () => {                    // take a real photo and read it; keep it if it's better
      if (!photoSupported()) { photoNote = "photo not supported by this browser"; return; }
      status("Taking a photo for a sharper read…");
      try {
        const ph = await photoSnapshot();
        if (ph?.failed) { photoNote = `photo ${ph.size.join("×")} in ${(ph.ms / 1000).toFixed(1)} s: ${ph.failed}`; return; }
        status("Reading the photo…");
        const R2 = await readSnap(ph), better = !R || rank(R2.res) > rank(R.res);
        photoNote = `photo ${ph.size.join("×")} in ${(ph.ms / 1000).toFixed(1)} s, ${better ? "used" : "no better than the video"}`;
        if (better) { R = R2; used = (ph.frame ? "frame + border" : "outer edge") + ", from the photo"; }
      } catch (e) { photoNote = "photo failed: " + (e?.message || e?.name || e); }
    };
    if (useMode === 4) {                              // photo only (the video frame only if no photo can be taken)
      await tryPhoto();
      if (!R) { R = await readSnap(snap); photoNote += ", read the video frame instead"; }
    } else {
      R = await readSnap(snap);
      if (useMode === 3 && rank(R.res) < 2 && R.res?.why !== "noindex") {
        // mode 3: a second video frame first; a photo only if that misses too (two misses in a row)
        status("Not identified: trying another frame…");
        await sleep(150); updateCard();
        if (cardRect) {
          const again = await readSnap(snapshotCard());
          if (rank(again.res) > rank(R.res)) R = again;
        }
        if (rank(R.res) < 2) await tryPhoto(); else photoNote = "second video frame worked, no photo needed";
      }
    }
    const { nm, st, names, name, info } = R, crops = [nm.cv, st.cv], rn = { data: nm.data }, rs = { data: st.data };
    let res = R.res;
    const t1 = performance.now();
    if (!name && !info.num && trigger === "auto") { status("No card text found. Hold the card upright, closer, in good light.", "warn"); return; }
    res ||= { card: null, how: "fail" };
    const t2 = performance.now();
    current = { name: res?.nameUsed || name, info, res, raw: { name: rn.data, set: rs.data }, crops, ms: { read: t1 - t0, lookup: t2 - t1 }, entry: null, mode: useMode, sharp: snap.sharp, used, photoNote };
    if (res.card) { addLog(res.card, res.how, t2 - t0); blip(); }
    else if (res.how === "fail") addLog(null, "fail", t2 - t0, name || info.sets.join("/") || "(nothing read)");
    renderResult();
    const newer = res.unknown ? ` The set code ${res.unknown} isn't in the card index (from ${(IDX.version?.source_updated || IDX.version?.built || "?").slice(0, 10)}): a newer set?` : "";
    status(res.card ? `Found: ${res.card.name}` : res.how === "choose" ? "Name found. Choose the printing you have (scanning is paused until you choose or skip)." + newer
      : res.why === "noindex" ? "The card index isn't loaded, so cards can't be identified yet. See the line below." : "Not recognised. Try again, or type the name." + newer,
      res.card ? "ok" : res.how === "choose" ? "warn" : "bad");
  } catch (err) {
    console.error(err); status("Error: " + err.message, "bad");
  } finally { busy = false; $("#capture").disabled = !source; }
}

// ------------------------------------------------------------------ sound
/* Sound: a short WAV made in the page, played through an <audio> element like any media (the most dependable way on
   phones), with Web Audio as a backup. Optional vibration (Android). Browsers only allow sound after a tap on the page. */
let audio = null, lastSound = "not played yet";
const beepWav = (() => {                            // two rising tones, 0.22 s, 22 kHz mono 16-bit
  const rate = 22050, n = Math.round(rate * 0.22), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate, second = t >= 0.1, f = second ? 1320 : 880, local = second ? t - 0.1 : t;
    const env = Math.min(1, local / 0.008) * Math.max(0, 1 - local / 0.11);
    v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * f * t) * env * 0.85 * 32767), true);
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
})();
const beepEl = new Audio(beepWav); beepEl.preload = "auto";
function unlockAudio() {
  try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); if (audio.state !== "running") audio.resume?.(); } catch {}
}
// browsers only allow sound after a tap, and may pause it again (e.g. after switching apps): every tap re-enables it
addEventListener("pointerdown", unlockAudio, { capture: true, passive: true });
addEventListener("keydown", unlockAudio, { capture: true });
function webAudioBeep() {
  if (!audio) return false;
  if (audio.state !== "running") audio.resume?.();
  const t = audio.currentTime + 0.02, master = audio.createGain(); master.gain.value = 0.9; master.connect(audio.destination);
  [[880, 0], [1320, 0.1]].forEach(([f, dt]) => {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = "triangle"; o.frequency.setValueAtTime(f, t + dt);
    g.gain.setValueAtTime(0.0001, t + dt); g.gain.exponentialRampToValueAtTime(1, t + dt + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.11);
    o.connect(g).connect(master); o.start(t + dt); o.stop(t + dt + 0.12);
  });
  return true;
}
/** Feedback for an identified card: sound and/or vibration, as switched on. Returns a short report of what happened. */
function blip(force = false) {
  if ($("#vibrate").checked || force) { try { navigator.vibrate?.(80); } catch {} }
  if (!$("#sound").checked && !force) return;
  window.__blips = (window.__blips || 0) + 1;       // counted for the automated tests
  try {
    beepEl.currentTime = 0; beepEl.volume = 1;
    const p = beepEl.play();
    lastSound = "playing…";
    Promise.resolve(p).then(() => { lastSound = "played"; diag(); },
      e => { const ok = (() => { try { return webAudioBeep(); } catch { return false; } })();
             lastSound = `blocked (${e?.name || e})` + (ok ? ", played with the backup method" : ""); diag(); });
  } catch (e) { lastSound = "failed: " + e.message; try { webAudioBeep(); } catch {} }
  diag();
}
for (const [id, key] of [["sound", "scanSound"], ["vibrate", "scanVibrate"]]) {
  try { const v = localStorage.getItem(key); if (v !== null) $("#" + id).checked = v !== "0"; } catch {}
  $("#" + id).onchange = () => { try { localStorage.setItem(key, $("#" + id).checked ? "1" : "0"); } catch {} };
}
$("#testSound").onclick = () => {
  unlockAudio(); blip(true);
  setTimeout(() => { $("#soundMsg").textContent = lastSound === "played" ? "Played. Nothing heard? Check the media volume, and that Chrome isn't muted for this site (site settings → Sound)."
    : `Sound ${lastSound}.`; }, 400);
};

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
        <p>${tag(c.res.how)}</p><p class="hint">Mode ${c.mode} · ${Math.round(c.ms.read + c.ms.lookup)} ms${c.sharp != null ? ` · sharpness ${Math.round(c.sharp)}` : ""}${c.used ? ` · card edge: ${esc(c.used)}` : ""}${c.photoNote ? ` · ${esc(c.photoNote)}` : ""}</p></div></div>`
    : `<p>${tag(c.res.how)}</p>` + (c.res.named ? `<p><b>${esc(c.res.named.name)}</b>: ${c.res.prints.length} printings.</p>` : "");
  const pw = $("#pickerWrap"); pw.hidden = !c.res.prints || !!card;
  choosing = !pw.hidden;                            // automatic scanning pauses until a printing is chosen or skipped
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
  $("#crops").insertAdjacentHTML("beforeend", `<code>${c.photoNote ? "Photo: " + esc(c.photoNote) + " · " : ""}Card edge: ${esc(c.used || "–")} · Name: ${esc(c.name || "–")} · Number: ${esc(c.info.num || "–")} · Set: ${esc(c.info.sets.join(", ") || "–")}${c.info.checked ? " (set + number found in the card index)" : ""} · Language: ${esc(c.info.lang || "–")}</code>`);
}
$("#picker").addEventListener("click", ev => {
  const b = ev.target.closest("button[data-id]"); if (!b || !current?.res.prints) return;
  const card = current.res.prints.find(p => p.id === b.dataset.id);
  const how = current.res.how === "typed-choose" ? "typed" : "chosen";
  current.res = { ...current.res, card, how };
  addLog(card, how, current.ms.read + current.ms.lookup);
  renderResult(); status(`Chosen: ${card.name} (${card.set.toUpperCase()} #${card.collector_number}). Show the next card.`, "ok");
});
let choosing = false;
$("#skipPick").onclick = () => {
  choosing = false; $("#pickerWrap").hidden = true;
  if (current) current.res = { ...current.res, prints: null };
  status("Skipped. Show the next card.");
};
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
      `<span>✖ not recognised: ${count("fail")}${pct(count("fail"))}</span> · <span>average ${(rows.reduce((s, l) => s + l.ms, 0) / t / 1000).toFixed(1)} s</span>` +
      `</div>`;
  };
  const modes = [1, 2, 3, 4].filter(m => log.some(l => l.mode === m));
  $("#stats").innerHTML = !log.length ? `<span class="hint">Nothing yet.</span>`
    : modes.length > 1 ? modes.map(m => line(log.filter(l => l.mode === m), `<b>Mode ${m}:</b> `)).join("") + line(log, "<b>All:</b> ")
    : line(log, modes.length ? `<b>Mode ${modes[0]}:</b> ` : "");
}
$("#copyLog").onclick = async () => {
  const text = [...log].reverse().filter(l => l.set).map(l => `1 ${l.name} (${l.set}) ${l.cn}`).join("\n");
  try { await navigator.clipboard.writeText(text); $("#copyMsg").textContent = "Copied."; } catch { $("#copyMsg").textContent = "Copy failed."; }
};
$("#clearLog").onclick = () => { log = []; renderLog(); };
renderLog();
loadIndex().catch(e => { IDX.state = "failed (" + e.message + "): cards can't be identified"; diag(); });

// typing a name: suggestions and search in the card index, then the printing picker
let acTimer = 0;
$("#manualName").addEventListener("input", () => {
  clearTimeout(acTimer); const q = normName($("#manualName").value); if (q.length < 2 || !IDX.data) return;
  acTimer = setTimeout(() => {
    const D = IDX.data, keys = [];
    for (const k of D.byName.keys()) if (k.startsWith(q)) keys.push(k);
    keys.sort((a, b) => a.length - b.length || a.localeCompare(b));         // shortest (closest) first
    $("#acList").innerHTML = [...new Set(keys.slice(0, 40).map(k => D.name[D.byName.get(k)[0]]))].slice(0, 12).map(n => `<option value="${esc(n)}">`).join("");
  }, 150);
});
function manualFind() {
  const q = $("#manualName").value.trim(); if (!q) return;
  if (!IDX.data) { status("The card index isn't loaded, so cards can't be looked up yet.", "bad"); return; }
  // typed: exact name, else the shortest name starting with what was typed, else the closest name
  const D = IDX.data, nq = normName(q);
  let key = D.byName.has(nq) ? nq : null;
  if (!key && nq.length >= 3) { for (const k of D.byName.keys()) if (k.startsWith(nq) && (!key || k.length < key.length)) key = k; }
  key ||= localName(q)?.key;
  if (!key) { status(`No card called “${q}” in the card index.`, "bad"); return; }
  const prints = D.byName.get(key).slice().sort((a, b) => (D.sets.get(D.set[b])?.released || "").localeCompare(D.sets.get(D.set[a])?.released || "")).map(printingOf);
  current = current || { name: "", info: { num: "", sets: [], lang: "" }, raw: { name: { text: "", confidence: 0 }, set: { text: "", confidence: 0 } }, crops: [document.createElement("canvas"), document.createElement("canvas")], ms: { read: 0, lookup: 0 } };
  current.res = prints.length === 1 ? { card: prints[0], how: "typed" } : { card: null, how: "typed-choose", named: prints[0], prints, suggested: new Set() };
  if (prints.length === 1) addLog(prints[0], "typed", 0);
  renderResult(); status(prints.length === 1 ? `Found: ${prints[0].name}` : "Choose the printing you have.", prints.length === 1 ? "ok" : "warn");
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
  // the camera chosen now, else the one used last time: by its id, or by its name if the browser changed the id
  let want = deviceId || "";
  if (!want) {
    let saved = null; try { saved = JSON.parse(localStorage.getItem("scanCamera") || "null"); } catch {}
    if (saved?.id) {
      const cams = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter(d => d.kind === "videoinput");
      want = (cams.find(c => c.deviceId === saved.id) || cams.find(c => c.label && c.label === saved.label))?.deviceId || saved.id;
    }
  }
  const open = id => navigator.mediaDevices.getUserMedia({ audio: false, video: id ? { ...base, deviceId: { exact: id } } : { ...base, facingMode: { ideal: "environment" } } });
  try {
    try { stream = await open(want); }
    catch (err) { if (!want || err.name === "NotAllowedError") throw err; stream = await open(""); }   // remembered camera gone: use the default
  } catch (err) {
    status(err.name === "NotAllowedError" ? "Camera permission was denied. Allow it in the browser's site settings." : "Could not start the camera: " + err.message, "bad"); return;
  }
  { const t = stream.getVideoTracks()[0]; try { localStorage.setItem("scanCamera", JSON.stringify({ id: t.getSettings().deviceId || "", label: t.label || "" })); } catch {} }
  video.srcObject = stream; await video.play(); ctlTouched = false;
  source = "video"; video.hidden = false; $("#placeholder").hidden = true;
  stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  const track = stream.getVideoTracks()[0], caps = track.getCapabilities?.() || {};
  $("#camInfo").textContent = `Camera: ${video.videoWidth}×${video.videoHeight}.`;
  setupCamControls(track); restoreZoom(track);
  // some phones report flashlight/focus/zoom only once the camera is delivering frames: check again shortly
  for (const ms of [700, 2000]) setTimeout(() => { if (stream?.getVideoTracks()[0] === track && !ctlTouched) { const had = !!zoomCaps; setupCamControls(track); if (!had) restoreZoom(track); } }, ms);
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
  const sel = $("#camSelect"); sel.innerHTML = cams.map((c, i) => `<option value="${esc(c.deviceId)}">${esc(c.label || "Camera " + (i + 1))}</option>`).join("");
  sel.value = track.getSettings().deviceId || ""; sel.hidden = cams.length < 2;
  $("#startCam").hidden = true; $("#stopCam").hidden = false; $("#capture").disabled = false;
  cardRect = null; pending = null; drawOverlay(); armed = true; prev = null; stillFor = 0;
  renderBox();
  status(boxActive() ? "Box mode: slide a card into the box." : "Hold a card in front of the camera.");
  getWorkers().then(() => status("Ready. Hold a card in front of the camera.")).catch(e => status("Text reader failed to load: " + e.message, "bad"));
}
function stopCamera() {
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  if (source === "video") { source = null; video.hidden = true; $("#placeholder").hidden = false; drawOverlay(); }
  $("#startCam").hidden = false; $("#stopCam").hidden = true; $("#camControls").hidden = true; $("#detailsRow").hidden = true; $("#camDump").hidden = true; $("#capture").disabled = !source;
}
$("#startCam").onclick = () => { unlockAudio(); startCamera(); };
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
  const z = caps.zoom, canZoom = !!(z && z.max > z.min);
  $("#zoomBox").hidden = !canZoom;
  zoomCaps = canZoom ? { min: z.min, max: z.max, step: z.step || 0.1 } : null;
  if (canZoom) { curZoom = set.zoom ?? z.min; showZoom(); }
  else { curZoom = null; $("#zoomVal").textContent = ""; missing.push("zoom"); }
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
/* Zoom: the slider is logarithmic (each part of it multiplies the zoom by the same amount), so the low end, where the
   card is usually framed, isn't crammed into a few pixels. − and + change it by about 5 %. The zoom is remembered per camera. */
let zoomTimer = 0;
const zoomSnap = v => { const { min, max, step } = zoomCaps; return Math.min(max, Math.max(min, min + Math.round((v - min) / step) * step)); };
const zoomFromPos = p => { const { min, max } = zoomCaps; return min > 0 ? min * Math.pow(max / min, p / 1000) : min + (max - min) * p / 1000; };
const posFromZoom = v => { const { min, max } = zoomCaps; return Math.round(min > 0 ? 1000 * Math.log(v / min) / Math.log(max / min) : 1000 * (v - min) / (max - min)); };
function showZoom() { if (!zoomCaps || curZoom == null) return; $("#zoom").value = posFromZoom(curZoom); $("#zoomVal").textContent = `${curZoom.toFixed(curZoom < 10 ? 2 : 1)}×`; renderBox(); }
function setZoom(v, now = false) {
  if (!zoomCaps) return; ctlTouched = true; curZoom = zoomSnap(v); showZoom(); clearTimeout(zoomTimer);
  zoomTimer = setTimeout(async () => {
    if (await setTrack({ zoom: curZoom })) {
      try { const id = stream?.getVideoTracks()[0]?.getSettings().deviceId || "", m = JSON.parse(localStorage.getItem("scanZoom") || "{}"); m[id] = curZoom; localStorage.setItem("scanZoom", JSON.stringify(m)); } catch {}
    }
  }, now ? 0 : 60);
}
$("#zoom").oninput = () => { if (zoomCaps) setZoom(zoomFromPos(+$("#zoom").value)); };
$("#zoomIn").onclick = () => { if (zoomCaps) setZoom(Math.max(curZoom * 1.05, curZoom + zoomCaps.step), true); };
$("#zoomOut").onclick = () => { if (zoomCaps) setZoom(Math.min(curZoom / 1.05, curZoom - zoomCaps.step), true); };
/** The zoom used last time with this camera, if it can zoom. */
function restoreZoom(track) {
  if (!zoomCaps) return;
  let m = {}; try { m = JSON.parse(localStorage.getItem("scanZoom") || "{}"); } catch {}
  const v = m[track.getSettings?.().deviceId || ""];
  if (typeof v === "number" && Math.abs(v - curZoom) > 0.001) setZoom(v, true);   // counts as a change by the user, so the later re-checks keep it
}
$("#copyDiag").onclick = () => { const t = `${$("#ver").textContent} · ${$("#status").textContent} · ${$("#diag").textContent}`;
  navigator.clipboard?.writeText(t).then(() => $("#idxMsg").textContent = "Diagnostics copied.", () => $("#idxMsg").textContent = "Couldn't copy; select the line and copy it."); };
$("#capture").onclick = () => { choosing = false; armed = false; lastShot = cardRect ? thumb() : null; movedSince = 0; scan("manual"); };   // an explicit capture ends a pending choice
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
const STILL = 12;                                 // average brightness change per pixel (0–255) that still counts as "not moving"
let armed = true, prev = null, stillFor = 0, lastShot = null, goneFor = 0, movedSince = 0, autoWhy = "";
/* A new card is recognised in two ways: the picture inside the outline clearly moved since the last capture (a card
   slid in, or was swapped), or it differs from the card captured last. Either one re-arms automatic capture. */
const MOVED = () => boxActive() ? 15 : 25;            // movement that counts as "something happened"
// box mode: the phone and the box don't move, so check more often and need a shorter still moment (~0.25 s instead of ~0.6 s)
const tick = () => setTimeout(() => { try { step(); } finally { tick(); } }, boxActive() ? 120 : 200);
function step() {
  if (source !== "video" || !video.videoWidth) return;
  if (!busy) updateCard();
  drawOverlay();
  if (!cardRect) {                                  // no card: re-arm after ~1 s, so the same card can be scanned again
    prev = null; stillFor = 0; motion = null; movedSince = 99; autoWhy = choosing ? "paused until you choose the printing or skip" : "no card found in the picture"; diag();
    if (++goneFor >= (boxActive() ? 8 : 5) && !armed) { armed = true; status(boxActive() ? "Slide a card into the box." : "Hold a card in front of the camera."); }
    return;
  }
  goneFor = 0;
  const t = thumb();
  motion = prev ? diff(t, prev) : null; prev = t;
  if (motion !== null) movedSince = Math.max(movedSince, motion);
  if (!$("#auto").checked) { autoWhy = "off"; diag(); return; }
  if (choosing) { autoWhy = "paused until you choose the printing or skip"; diag(); return; }
  if (busy) { autoWhy = "reading…"; diag(); return; }
  if (!armed) {
    const changed = lastShot ? diff(t, lastShot) : 99;
    if (movedSince > MOVED() || changed > 10) { armed = true; stillFor = 0; status("Hold the card still…"); }
    else { autoWhy = `waiting for a new card (difference from the last one ${changed.toFixed(0)}, needs 10; or movement)`; diag(); return; }
  }
  if (cardRect.h < MIN_CARD_PX) { stillFor = 0; autoWhy = `card too small in the picture (${Math.round(cardRect.h)} px tall, needs ${MIN_CARD_PX}): move the camera closer`; diag(); return; }
  if (detMiss > 2) { stillFor = 0; autoWhy = "card not found in the last frames"; diag(); return; }
  if (detMiss > 0) { autoWhy = "card not found in this frame (keeps waiting)"; diag(); return; }   // one missed frame doesn't restart the wait
  stillFor = motion !== null && motion < STILL ? stillFor + 1 : 0;
  const need = boxActive() ? 2 : 3;
  autoWhy = `waiting for a still card (${stillFor}/${need}, movement ${motion == null ? "–" : motion.toFixed(1)}, still below ${STILL})`; diag();
  if (stillFor >= need) { armed = false; lastShot = t; stillFor = 0; movedSince = 0; scan("auto"); }
}
tick();

