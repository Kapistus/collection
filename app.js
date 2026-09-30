/* Binder Share — view, filter and share MTG collections from ManaBox CSV exports.
   Everything runs in the browser. Card data and images: Scryfall (https://scryfall.com/docs/api). */
"use strict";

// ------------------------------------------------------------------ constants
// Keep equal to <meta name="app-version"> and the ?v= in index.html; bump all three on each release.
const APP_VERSION = "2026.09.30-2";
const API = "https://api.scryfall.com";
const BATCH = 75;              // max identifiers per /cards/collection request
const DELAY = 100;             // ms between API requests (Scryfall asks for 50–100 ms)
const CARD_TTL = 24 * 3600e3;  // prices update once a day
const CODE_PREFIX = "MTG1";
const QR_CHUNK = 2600;         // payload characters per QR code part (version 40-L holds 2953 bytes)
const QR_LINK_MAX = 2900;      // a whole share link fits in one QR code up to this length
const SHEET_MAX_PICS = 150;    // more entries than this -> compact share image
const COLORS = "WUBRG";
const RARITIES = ["common", "uncommon", "rare", "mythic", "special"];
const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 4, bonus: 5 };
const TYPES = ["Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment", "Land"];
const K = { cards: "bs.cards", cols: "bs.collections", lists: "bs.lists", view: "bs.view", active: "bs.active", zoom: "bs.zoom", want: "bs.want",
            choiceUpdate: "bs.choice.update", choiceNew: "bs.choice.new", choiceList: "bs.choice.list", lastTarget: "bs.lastTarget", mergeMode: "bs.mergeMode" };

// ------------------------------------------------------------------ small helpers
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
function hashStr(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
function cnKey(cn) { const m = /^(\d+)/.exec(cn || ""); return [m ? parseInt(m[1], 10) : 1e9, cn || ""]; }
function cmp(a, b) { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; }
let toastTimer;
/** Short message at the bottom; `action` = [label, fn] adds a button (e.g. Undo). */
function toast(msg, ms = 3500, action = null) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  if (action) {
    const b = document.createElement("button"); b.textContent = action[0];
    b.onclick = () => { t.hidden = true; clearTimeout(toastTimer); action[1](); };
    t.append(" ", b);
  }
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function load(key, def) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch { return def; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; }
  catch (e) {
    if (key !== K.cards) {           // make room by dropping the card cache (it can be re-downloaded)
      try { localStorage.removeItem(K.cards); cardCache = {}; localStorage.setItem(key, JSON.stringify(val)); return true; } catch {}
      toast("Browser storage is full: could not save. Delete collections you no longer need.", 6000);
    } else {
      const keys = Object.keys(val).sort((a, b) => val[a].t - val[b].t);   // drop oldest half and retry
      keys.slice(0, Math.ceil(keys.length / 2)).forEach(k => delete val[k]);
      try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch {}
    }
    return false;
  }
}

// ------------------------------------------------------------------ CSV (ManaBox export)
function parseCSV(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = ""; if (row.some(v => v !== "")) rows.push(row); row = [];
    } else field += c;
  }
  row.push(field); if (row.some(v => v !== "")) rows.push(row);
  return rows;
}

function csvToEntries(text) {
  const rows = parseCSV(text.replace(/^﻿/, ""));
  if (!rows.length) throw new Error("The file is empty.");
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = name => head.indexOf(name);
  const need = ["name", "set code", "collector number"];
  if (need.some(n => col(n) < 0)) throw new Error("This doesn't look like a ManaBox CSV export (needs Name, Set code and Collector number columns).");
  const get = (r, name) => { const i = col(name); return i < 0 ? "" : (r[i] || "").trim(); };
  const entries = [];
  for (const r of rows.slice(1)) {
    const name = get(r, "name"); if (!name) continue;
    const set = get(r, "set code").toLowerCase(), cn = get(r, "collector number");
    const foil = (get(r, "foil") || "normal").toLowerCase();
    entries.push({
      k: `${set}|${cn}`, set, cn, name,
      finish: foil === "foil" || foil === "etched" ? foil : "normal",
      qty: Math.max(1, parseInt(get(r, "quantity"), 10) || 1),
      sid: get(r, "scryfall id"), setName: get(r, "set name"), rarity: get(r, "rarity").toLowerCase(),
      binder: get(r, "binder name"), binderType: get(r, "binder type"),
      condition: get(r, "condition"), language: get(r, "language"),
      paid: num(get(r, "purchase price")), paidCur: get(r, "purchase price currency"), added: get(r, "added"),
    });
  }
  if (!entries.length) throw new Error("No cards found in the file.");
  return entries;
}

// ------------------------------------------------------------------ Scryfall data
let cardCache = load(K.cards, {});   // { "set|cn": { t: timestamp, c: trimmedCard } }

function trimImages(o) { const u = o && o.image_uris; return u ? { normal: u.normal, large: u.large } : null; }
function trimCard(c) {
  const faces = (c.card_faces || []).map(f => ({
    name: f.name || "", mana_cost: f.mana_cost || "", type_line: f.type_line || "", oracle_text: f.oracle_text || "",
    power: f.power, toughness: f.toughness, loyalty: f.loyalty, colors: f.colors, images: trimImages(f),
  }));
  let colors = c.colors;
  if (!colors) colors = [...new Set(faces.flatMap(f => f.colors || []))];
  return {
    id: c.id, name: c.name || "", set: c.set || "", set_name: c.set_name || "", cn: c.collector_number || "",
    rarity: c.rarity || "",
    mana_cost: c.mana_cost ?? faces.map(f => f.mana_cost).filter(Boolean).join(" // "),
    cmc: c.cmc || 0,
    type_line: c.type_line || faces.map(f => f.type_line).join(" // "),
    oracle_text: c.oracle_text ?? faces.map(f => f.oracle_text).join("\n//\n"),
    power: c.power, toughness: c.toughness, loyalty: c.loyalty,
    colors, color_identity: c.color_identity || [], keywords: c.keywords || [],
    prices: c.prices || {}, uri: c.scryfall_uri || "", artist: c.artist || "",
    images: trimImages(c), faces,
  };
}
const cardFor = e => cardCache[e.k]?.c || null;
function imageUrls(card, size = "normal") {
  if (!card) return [];
  if (card.images) return [card.images[size] || card.images.normal];
  return card.faces.filter(f => f.images).map(f => f.images[size] || f.images.normal);
}
function priceFrom(prices, finish) {
  const suf = finish === "foil" ? "_foil" : finish === "etched" ? "_etched" : "";
  for (const cur of ["eur", "usd"]) {
    let v = num(prices?.[cur + suf]);
    if (v === null && suf === "_etched") v = num(prices?.[cur + "_foil"]);
    if (v !== null) return [v, cur];
  }
  return [null, ""];
}
function priceOf(e) { const c = cardFor(e); return c ? priceFrom(c.prices, e.finish) : [null, ""]; }
/** Previous (different) price of a card and when it was fetched, or null. */
function prevPriceOf(e) {
  const p = cardCache[e.k]?.prev; if (!p) return null;
  const [v, cur] = priceFrom(p.prices, e.finish);
  return v === null ? null : { v, cur, t: p.t };
}
/** Value change of entries since their previous prices (EUR only, cards without a previous price are skipped). */
function changeOf(entries) {
  let diff = 0, n = 0, since = Infinity;
  for (const e of entries) {
    const prev = prevPriceOf(e), [now, cur] = priceOf(e);
    if (!prev || now === null || prev.cur !== cur || cur !== "eur") continue;
    diff += (now - prev.v) * e.qty; n += e.qty; since = Math.min(since, prev.t);
  }
  return n ? { diff, n, since } : null;
}
const fmtPrice = (v, cur) => v === null ? "–" : (cur === "eur" ? "€" : "$") + v.toFixed(2);
const nameOf = e => e.name || cardFor(e)?.name || `${e.set.toUpperCase()} #${e.cn}`;

let fetching = false;
async function fetchCards(entries, { force = false, olderThan = CARD_TTL } = {}) {
  if (fetching) return;
  const now = Date.now(), seen = new Set(), todo = [];
  for (const e of entries) {
    if (seen.has(e.k)) continue; seen.add(e.k);
    const hit = cardCache[e.k];
    if (!hit || (force && now - hit.t > olderThan) || now - hit.t > CARD_TTL) todo.push(e);
  }
  if (!todo.length) return;
  fetching = true;
  const prog = $("#progress"); prog.hidden = false;
  const notFound = []; let error = "";
  try {
    for (let i = 0; i < todo.length; i += BATCH) {
      prog.textContent = `Loading card data from Scryfall… ${i}/${todo.length}`;
      const chunk = todo.slice(i, i + BATCH);
      const identifiers = chunk.map(e => e.sid ? { id: e.sid } : { set: e.set, collector_number: e.cn });
      let res;
      try {
        res = await fetch(`${API}/cards/collection`, {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ identifiers }),
        });
      } catch { error = "Could not reach Scryfall. Check your connection; cached data is shown."; break; }
      if (res.status === 429) { error = "Scryfall rate limit reached. Try again in a minute."; break; }
      if (!res.ok) { error = `Scryfall returned an error (HTTP ${res.status}).`; break; }
      const data = await res.json();
      const byId = {}, bySetCn = {};
      for (const raw of data.data || []) { const t = trimCard(raw); byId[t.id] = t; bySetCn[`${t.set}|${t.cn}`] = t; }
      // results can't be matched by position (missing cards shift them), so match by id / set+number
      const t = Date.now();
      for (const e of chunk) {
        const card = (e.sid && byId[e.sid]) || bySetCn[e.k];
        if (card) {
          // keep the last *different* prices, so the change display survives refetches that return the same prices
          const old = cardCache[e.k]; let prev = old?.prev || null;
          if (old && JSON.stringify(old.c.prices) !== JSON.stringify(card.prices)) prev = { t: old.t, prices: old.c.prices };
          cardCache[e.k] = prev ? { t, c: card, prev } : { t, c: card };
        } else notFound.push(e);
      }
      if (i + BATCH < todo.length) await sleep(DELAY);
    }
  } finally {
    fetching = false; prog.hidden = true;
    save(K.cards, cardCache);
  }
  const nf = new Set(notFound.map(e => e.k));
  for (const e of entries) e.notFound = nf.has(e.k);
  if (notFound.length) toast(`${notFound.length} card(s) were not found on Scryfall.`, 6000);
  if (error) toast(error, 7000);
}

// ------------------------------------------------------------------ share code
// Text before compression:
//   line 1: title
//   line 2: set:cn[*qty][!f|!e],cn…;set:…   (sets and numbers sorted; defaults 1× nonfoil omitted)
// Code: "MTG1:" + base64url(deflate-raw(utf-8 text)).   QR chunks: "MTG1-<i>of<n>-<id>:" + slice.
const cnEsc = s => s.replace(/[%,;:*!\n]/g, c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"));
const cnUnesc = s => s.replace(/%([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

function b64url(bytes) {
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }

const LIST_MARK = "L\u001f";   // title-line prefix: the code came from a list (imports as an editable list)
async function encodeCode(title, entries, kind = "collection") {
  const groups = new Map();   // merge duplicates (same printing + finish across binders)
  for (const e of entries) {
    const c = cardFor(e);
    const set = (c ? c.set : e.set).toLowerCase(), cn = c ? c.cn : e.cn;   // prefer Scryfall's own codes
    const key = `${set}\u0000${cn}\u0000${e.finish}`;
    const g = groups.get(key); if (g) g.qty += e.qty; else groups.set(key, { set, cn, finish: e.finish, qty: e.qty });
  }
  const bySet = new Map();
  for (const g of groups.values()) { if (!bySet.has(g.set)) bySet.set(g.set, []); bySet.get(g.set).push(g); }
  const body = [...bySet.keys()].sort().map(set => set + ":" + bySet.get(set)
    .sort((a, b) => cmp(cnKey(a.cn), cnKey(b.cn)) || a.finish.localeCompare(b.finish))
    .map(g => cnEsc(g.cn) + (g.qty > 1 ? "*" + g.qty : "") + (g.finish === "foil" ? "!f" : g.finish === "etched" ? "!e" : ""))
    .join(",")).join(";");
  const text = (kind === "list" ? LIST_MARK : "") + title.replace(/[\r\n\u001f]+/g, " ").slice(0, 80) + "\n" + body;
  const z = await pipe(new TextEncoder().encode(text), new CompressionStream("deflate-raw"));
  return `${CODE_PREFIX}:${b64url(z)}`;
}

async function decodeCode(code) {
  const m = /^MTG1:([A-Za-z0-9_-]+)$/.exec(code.trim());
  if (!m) throw new Error("Not a Binder Share code.");
  let text;
  try { text = new TextDecoder().decode(await pipe(unb64url(m[1]), new DecompressionStream("deflate-raw"))); }
  catch { throw new Error("The code is damaged or incomplete."); }
  const nl = text.indexOf("\n");
  let head = text.slice(0, nl), kind = "collection";
  if (head.startsWith(LIST_MARK)) { kind = "list"; head = head.slice(LIST_MARK.length); }
  const title = head.trim() || "Shared cards", body = text.slice(nl + 1);
  const entries = [];
  for (const part of body.split(";")) {
    if (!part) continue;
    const i = part.indexOf(":"); const set = part.slice(0, i);
    for (const tok of part.slice(i + 1).split(",")) {
      const t = /^(.*?)(?:\*(\d+))?(?:!(f|e))?$/.exec(tok); if (!t || !t[1]) continue;
      const cn = cnUnesc(t[1]);
      entries.push({ k: `${set}|${cn}`, set, cn, qty: parseInt(t[2] || "1", 10),
                     finish: t[3] === "f" ? "foil" : t[3] === "e" ? "etched" : "normal" });
    }
  }
  if (!entries.length) throw new Error("The code contains no cards.");
  return { title, entries, kind };
}

const shareBase = () => location.origin + location.pathname.replace(/index\.html$/, "");
/** Texts to put in QR codes: the whole share link if it fits in one (phone cameras then open the site),
    otherwise the code split into parts. */
function qrTexts(code) {
  const link = shareBase() + "#" + code;
  return link.length <= QR_LINK_MAX ? [link] : splitForQR(code);
}
function splitForQR(code) {
  if (code.length <= QR_CHUNK) return [code];
  const data = code.slice(CODE_PREFIX.length + 1), n = Math.ceil(data.length / QR_CHUNK), id = hashStr(code).slice(0, 4);
  return Array.from({ length: n }, (_, i) => `${CODE_PREFIX}-${i + 1}of${n}-${id}:` + data.slice(i * QR_CHUNK, (i + 1) * QR_CHUNK));
}
/** Turn texts from QR codes / pasted text into complete codes. */
function assembleCodes(texts) {
  const whole = [], parts = {};
  for (const raw of texts) {
    const txt = raw.trim();
    const hashAt = txt.indexOf("#MTG1"); const t = hashAt >= 0 ? txt.slice(hashAt + 1) : txt;
    let m;
    if ((m = /^MTG1:[A-Za-z0-9_-]+/.exec(t))) whole.push(m[0]);
    else if ((m = /^MTG1-(\d+)of(\d+)-([a-z0-9]+):([A-Za-z0-9_-]+)/.exec(t))) {
      const [, i, n, id, data] = m; (parts[id] ||= { n: +n, got: {} }).got[+i] = data;
    }
  }
  const missing = [];
  for (const [id, p] of Object.entries(parts)) {
    const have = Object.keys(p.got).length;
    if (have === p.n) whole.push(`${CODE_PREFIX}:` + Array.from({ length: p.n }, (_, i) => p.got[i + 1]).join(""));
    else missing.push(`${have} of ${p.n} QR codes found`);
  }
  return { codes: [...new Set(whole)], missing };
}

// ------------------------------------------------------------------ QR reading (zxing-wasm)
let zxingReady = false;
function prepareZXing() {
  if (zxingReady) return;
  ZXingWASM.prepareZXingModule({
    overrides: { locateFile: (p, prefix) => p.endsWith(".wasm") ? new URL("vendor/" + p, location.href).href : prefix + p },
  });
  zxingReady = true;
}
async function readQRTexts(blob) {
  prepareZXing();
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 4000 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement("canvas");
  cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
  const ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  const results = await ZXingWASM.readBarcodes(ctx.getImageData(0, 0, cv.width, cv.height),
    { formats: ["QRCode"], tryHarder: true, maxNumberOfSymbols: 16 });
  return results.filter(r => r.isValid !== false && r.text).map(r => r.text);
}

// ------------------------------------------------------------------ state
let collections = load(K.cols, []);   // [{ id, title, kind: "csv"|"code", created, entries }]
let lists = load(K.lists, []);        // [{ id, name, created, items }]
let viewId = load(K.view, "");        // "c:<id>" or "l:<id>"
let activeListId = load(K.active, "");
const selected = new Set();
let lastClicked = null;
const F = { q: "", sort: "name", asc: true, set: "", kw: "", type: "", binder: "", colors: new Set(), mode: "any", rar: new Set(), foil: false,
            want: null };   // want: Set of normalized card names (from Compare), or null
const itemKey = e => `${e.k}|${e.finish}`;
const saveCollections = () => save(K.cols, collections.map(c => ({ ...c, entries: c.entries.map(({ uid, notFound, ...e }) => e) })));
const saveLists = () => save(K.lists, lists.map(l => ({ ...l, items: l.items.map(({ uid, notFound, ...e }) => e) })));
const cardCount = arr => arr.reduce((s, e) => s + e.qty, 0);

function currentView() {
  const type = viewId.slice(0, 1), id = viewId.slice(2);
  if (type === "c") { const c = collections.find(x => x.id === id); if (c) return { type, obj: c, title: c.title, entries: c.entries }; }
  if (type === "l") { const l = lists.find(x => x.id === id); if (l) return { type, obj: l, title: l.name, entries: l.items }; }
  return null;
}

function setView(id) {
  viewId = id; save(K.view, viewId); selected.clear(); lastClicked = null;
  const v = currentView();
  if (v) v.entries.forEach((e, i) => { e.uid = v.type === "c" ? "i" + i : itemKey(e); });
  renderAll();
  if (v) fetchCards(v.entries).then(renderAll);
}

/** Ask with custom buttons; resolves to the chosen value, or null if dismissed.
    With rememberKey, the previous answer becomes the highlighted default (Enter repeats it) and a new answer is saved. */
function askChoice(title, text, buttons, rememberKey = null, select = null, radios = null) {
  return new Promise(resolve => {
    const d = $("#askDlg"), box = $("#askBtns");
    $("#askTitle").textContent = title; $("#askText").textContent = text; box.innerHTML = "";
    const wrap = $("#askSelectWrap"), sel = $("#askSelect");
    wrap.hidden = !select;
    if (select) {
      $("#askSelectLabel").textContent = select.label; sel.innerHTML = "";
      for (const [v, l] of select.options) sel.add(new Option(l, v));
      sel.value = select.value;
    }
    const rbox = $("#askRadios"), rlist = $("#askRadioList");
    rbox.hidden = !radios; rlist.innerHTML = "";
    if (radios) {
      $("#askRadiosLabel").textContent = radios.label;
      for (const [v, label] of radios.options) {
        const l = document.createElement("label"); l.className = "check";
        l.innerHTML = `<input type="radio" name="askRadio" value="${esc(v)}"> <span>${label}</span>`;
        if (v === radios.value) l.querySelector("input").checked = true;
        rlist.append(l);
      }
    }
    const hint = $("#askHint");
    const result2 = $("#askResult");
    const showHint = () => {
      let t = select?.hint?.(sel.value, rlist.querySelector("input:checked")?.value) || ""; if (!Array.isArray(t)) t = [t, ""];
      hint.hidden = !t[0]; hint.textContent = t[0]; result2.hidden = !t[1]; result2.textContent = t[1];
    };
    sel.onchange = showHint; rlist.onchange = showHint; showHint();
    const last = rememberKey ? load(rememberKey, null) : null;
    const preferred = buttons.some(([v]) => v !== null && v !== "cancel" && v === last) ? last : buttons.find(b => b[2])?.[0];
    let result = null, focusBtn = null;
    for (const [value, label] of buttons) {
      const b = document.createElement("button");
      b.textContent = label + (rememberKey && value !== null && value === last ? " (last used)" : "");
      if (value !== null && value === preferred) { b.className = "primary"; focusBtn = b; }
      b.onclick = () => { result = value; d.close(); }; box.append(b);
    }
    d.addEventListener("close", () => {
      if (result === "cancel") result = null;
      if (rememberKey && result) save(rememberKey, result);
      const mode = radios ? document.querySelector('input[name="askRadio"]:checked')?.value : undefined;
      if (radios && result && mode) save(radios.rememberKey, mode);
      resolve(select ? (result ? { choice: result, target: sel.value, mode } : null) : result);
    }, { once: true });
    d.showModal(); focusBtn?.focus();
  });
}
const uniqueName = (name, taken) => { if (!taken.has(name)) return name; let i = 2; while (taken.has(`${name} (${i})`)) i++; return `${name} (${i})`; };
const contentKey = arr => arr.map(e => `${itemKey(e)}*${e.qty}`).sort().join(",");
const REPLACE_BUTTONS = [["replace", "Replace", true], ["keep", "Keep both"], [null, "Cancel"]];

const contentKeyRows = arr => arr.map(e => rowKey(e) + "*" + e.qty).sort().join("\n");
/** One physical ManaBox row: same printing, finish, binder, condition, language and "Added" timestamp. */
const rowKey = e => [e.sid || e.k, e.finish, e.binder || "", e.condition || "", e.language || "", e.added || ""].join("|");
/** Merge modes (collections):
    "missing" = add only printings (card + finish) the collection doesn't have at all, whatever binder, condition,
                language or scan time the existing copies have;
    "update"  = for a newer ManaBox export of the same collection: rows are matched exactly (same printing, finish,
                binder, condition, language and "Added" time), known rows take the new quantity, other rows are added;
                shares are matched by printing + finish;
    "all"     = add everything, summing quantities into a matching row (same row, else same printing + condition +
                language, else same printing). */
const stackKey = e => [itemKey(e), e.condition || "", e.language || ""].join("|");
function mergeInto(col, entries, kind = "csv", mode = "update") {
  const byRow = kind === "csv" && col.kind === "csv";
  const rows = new Map(), stacks = new Map(), items = new Map();
  const index = e => { rows.set(rowKey(e), e); if (!stacks.has(stackKey(e))) stacks.set(stackKey(e), e); if (!items.has(itemKey(e))) items.set(itemKey(e), e); };
  col.entries.forEach(index);
  let added = 0, updated = 0, same = 0;
  let gained = 0;
  const push = e => { const n = { ...e }; col.entries.push(n); index(n); added++; gained += e.qty; };
  for (const e of entries) {
    if (mode === "missing") { if (items.has(itemKey(e))) same++; else push(e); continue; }
    if (mode === "all") {
      const old = (byRow && rows.get(rowKey(e))) || stacks.get(stackKey(e)) || items.get(itemKey(e));
      if (old) { old.qty += e.qty; gained += e.qty; updated++; } else push(e);
      continue;
    }
    const old = byRow ? rows.get(rowKey(e)) : items.get(itemKey(e));
    if (!old) push(e);
    else if (old.qty !== e.qty) { gained += e.qty - old.qty; old.qty = e.qty; updated++; }
    else same++;
  }
  return { added, updated, same, mode, gained };
}
/** How many entries of collection c have a printing + finish that is also in `entries`. */
function overlap(c, entries) {
  const keys = new Set(entries.map(itemKey));
  return c.entries.reduce((n, e) => n + (keys.has(itemKey(e)) ? 1 : 0), 0);
}
function createCollection(title, kind, entries, id) {
  const c = { id: id || hashStr(kind + title + Date.now()), title: uniqueName(title, new Set(collections.map(x => x.title))), kind, created: Date.now(), entries };
  collections.push(c); saveCollections(); setView("c:" + c.id);
  return c;
}
const reportMerge = (r, target) => toast(r.added || r.updated
  ? `Merged into “${target.title}”: added ${r.added} new entr${r.added === 1 ? "y" : "ies"}` +
    (r.updated ? (r.mode === "all" ? `, added copies to ${r.updated} existing` : `, updated ${r.updated} quantit${r.updated === 1 ? "y" : "ies"}`) : "") +
    (r.same ? ` · ${r.same} ${r.mode === "missing" ? "already there, skipped" : "unchanged"}` : "") + "."
  : `Nothing new: all ${r.same} entries were already in “${target.title}”.`, 6000);

const newListId = () => "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const toListItem = (e, from) => ({ k: e.k, set: e.set, cn: e.cn, finish: e.finish, qty: e.qty, owned: Math.max(e.owned || 0, e.qty),
  name: e.name || "", sid: e.sid || "", setName: e.setName || "", rarity: e.rarity || "", binder: e.binder || "",
  condition: e.condition || "", language: e.language || "", from: e.from || from });
/** Merge into a list by printing + finish: new printings are added, known ones take the new quantity. */
function mergeIntoList(l, entries, from, mode = "update") {
  const byKey = new Map(l.items.map(i => [itemKey(i), i]));
  let added = 0, updated = 0, same = 0, gained = 0;
  for (const e of entries) {
    const old = byKey.get(itemKey(e));
    if (!old) { const it = toListItem(e, from); l.items.push(it); byKey.set(itemKey(e), it); added++; gained += e.qty; }
    else if (mode === "all") { old.qty += e.qty; gained += e.qty; old.owned = Math.max(old.owned || 0, old.qty); updated++; }
    else if (mode === "update" && old.qty !== e.qty) { gained += e.qty - old.qty; old.qty = e.qty; old.owned = Math.max(old.owned || 0, e.qty); updated++; }
    else same++;
  }
  return { added, updated, same, mode, gained };
}
/** Every collection and list the import could go into. */
function importTargets() {
  return [...collections.map(c => ({ type: "c", obj: c, id: "c:" + c.id, title: c.title, entries: c.entries })),
          ...lists.map(l => ({ type: "l", obj: l, id: "l:" + l.id, title: l.name, entries: l.items }))];
}
function isIdentical(t, entries, kind) {
  if (t.entries.length !== entries.length) return false;
  if (t.type === "c" && t.obj.kind === "csv" && kind === "csv") return contentKeyRows(t.entries) === contentKeyRows(entries);
  return contentKey(t.entries) === contentKey(entries);
}
/** Cards in common, judged by printing + finish (binder, condition, language and scan time don't matter). */
function overlapWith(t, entries) {
  const keys = new Set(entries.map(itemKey));
  return t.entries.reduce((n, e) => n + (keys.has(itemKey(e)) ? 1 : 0), 0);
}
/** How many imported entries are already in target t: `cards` by printing + finish; `rows` (ManaBox CSV into a
    ManaBox collection only) by exact row, which is what "New cards and changed quantities" goes by. */
function presentIn(t, entries, kind) {
  const items = new Set(t.entries.map(itemKey));
  const cards = entries.reduce((n, e) => n + (items.has(itemKey(e)) ? 1 : 0), 0);
  if (!(t.type === "c" && t.obj.kind === "csv" && kind === "csv")) return { cards, rows: null };
  const rows = new Set(t.entries.map(rowKey));
  return { cards, rows: entries.reduce((n, e) => n + (rows.has(rowKey(e)) ? 1 : 0), 0) };
}
const targetLabel = t => `${t.type === "c" ? "Collection" : "List"}: ${t.title} (${cardCount(t.entries)} cards)`;

/** Import cards (ManaBox CSV, shared collection or shared list). Any existing collection or list can be the target:
    1. identical to one of them    -> ask if you really want to import the same thing again (Cancel is the default)
    2. overlaps one of them        -> merge into it (preselected, any other can be chosen), create new, or replace
    3. nothing in common           -> merge into a collection or list you choose, or create new */
async function importCards(title, kind, entries, asList = false) {
  const what = kind === "csv" ? "file" : asList ? "shared list" : "shared collection";
  const from = "imported " + new Date().toLocaleDateString();
  const createNew = () => {
    if (asList) {
      const l = { id: newListId(), name: uniqueName(title, new Set(lists.map(x => x.name))), created: Date.now(), items: entries.map(e => toListItem(e, from)) };
      lists.push(l); saveLists(); setView("l:" + l.id); return l;
    }
    return createCollection(title, kind, entries);
  };
  const targets = importTargets();
  if (!targets.length) return createNew();
  const newLabel = asList ? "Create new list" : "Create new collection";

  // 1. exactly the same as something you have
  const same = targets.find(t => isIdentical(t, entries, kind));
  if (same) {
    const choice = await askChoice(`Import the same ${same.type === "c" ? "collection" : "list"} again?`,
      `This ${what} is identical to your ${same.type === "c" ? "collection" : "list"} “${same.title}” (${same.entries.length} entries, ${cardCount(same.entries)} cards). Importing it again creates a duplicate.\n\nAre you sure?`,
      [["cancel", "Cancel", true], ["new", asList ? "Import anyway as a new list" : "Import anyway as a new collection"]]);
    if (choice !== "new") { setView(same.id); return null; }
    return createNew();
  }

  // 2. / 3.
  // prefer the same type: a shared list's cards always come from some collection, so a list should match a list
  const wantType = asList ? "l" : "c";
  const scored = targets.map(t => ({ t, n: overlapWith(t, entries) }))
    .sort((a, b) => ((b.n > 0 && b.t.type === wantType) - (a.n > 0 && a.t.type === wantType)) || b.n - a.n);
  const best = scored[0].n > 0 ? scored[0] : null;
  const cur = currentView();
  const preselect = best?.t.id || targets.find(t => t.id === load(K.lastTarget, ""))?.id || (cur && targets.find(t => t.id === viewId)?.id) || targets[0].id;
  const unit = kind === "csv" ? "row" : "entry", units = kind === "csv" ? "rows" : "entries";
  const nf = n => n.toLocaleString("en-US");
  const plural = (n, one, many) => `${nf(n)} ${n === 1 ? one : many}`;
  const typeName = t => t.type === "c" ? "collection" : "list";
  const text = (best
    ? `This ${what} has ${plural(cardCount(entries), "card", "cards")} in ${plural(entries.length, unit, units)}. Some of them are already in your ${typeName(best.t)} “${best.t.title}”.`
    : `None of the ${plural(cardCount(entries), "card", "cards")} in this ${what} are in your collections or lists.`) +
    `\n\n• Merge into selected: adds this ${what} to the collection or list chosen below, whatever its name. Nothing is removed.` +
    (best ? `\n• Replace selected: the chosen one becomes exactly this ${what}. Cards that aren't in it are removed.` : "") +
    `\n• ${newLabel}: keeps this ${what} separate.`;
  // dry run of a merge, for the preview under the dropdown
  const preview = (t, mode) => {
    const before = cardCount(t.entries);
    const r = t.type === "c"
      ? (c => mergeInto(c, entries, asList ? "code" : kind, mode))({ kind: t.obj.kind, entries: t.entries.map(e => ({ ...e })) })
      : (l => mergeIntoList(l, entries, from, mode))({ items: t.entries.map(e => ({ ...e })) });
    return { ...r, before, after: before + r.gained };
  };
  const buttons = [["merge", "Merge into selected", true], ["new", newLabel]];
  if (best) buttons.push(["replace", "Replace selected"]);
  buttons.push(["cancel", "Cancel"]);
  const res = await askChoice(best ? "Update an existing collection or list?" : "Merge or create new?",
    text, buttons, best ? K.choiceUpdate : K.choiceNew,
    { label: "Into", options: targets.map(t => [t.id, targetLabel(t)]), value: preselect,
      hint: (id, mode) => { const t = targets.find(x => x.id === id); if (!t) return "";
        const { cards: n, rows } = presentIn(t, entries, kind);
        let h = `${nf(n)} of the ${plural(entries.length, unit, units)} in this ${what} ${n === 1 ? "is a card" : "are cards"} already in “${t.title}”, ${nf(entries.length - n)} ${entries.length - n === 1 ? "is" : "are"} not.`;
        if (rows !== null && n > rows) h += rows
          ? ` Only ${nf(rows)} of them match its rows exactly (same binder, condition, language and scan date).`
          : ` None of them match its rows exactly (same binder, condition, language and scan date), so this isn't a newer export of it.`;
        if (!mode) return h;
        const r = preview(t, mode), parts = [];
        if (r.added) parts.push(`adds ${plural(r.added, unit, units)}`);
        if (r.updated) parts.push(mode === "all" ? `adds copies to ${plural(r.updated, unit, units)} already there` : `changes the quantity of ${plural(r.updated, unit, units)}`);
        if (r.same) parts.push(`skips ${plural(r.same, unit, units)} already there`);
        return [h, `Result: ${parts.join(", ") || "nothing changes"}. “${t.title}” ` +
          (r.after === r.before ? `stays at ${plural(r.before, "card", "cards")}.` : `goes from ${plural(r.before, "card", "cards")} to ${nf(r.after)}.`)]; } },
    { label: "When merging", rememberKey: K.mergeMode, value: load(K.mergeMode, "update"), options: [
      ["missing", "<b>Only add cards that aren't there yet</b><br><span class=\"hint\">Skips cards already there: same set, collector number and foil, in any binder, condition or language.</span>"],
      ["update", kind === "csv"
        ? "<b>Update from a newer ManaBox export</b><br><span class=\"hint\">For re-importing your collection after scanning more cards. Rows that match exactly (also binder, condition, language and scan date) get the file's quantity. Other rows are added, even for cards already there.</span>"
        : "<b>Update from a newer version</b><br><span class=\"hint\">For re-importing an updated share of the same collection or list. Cards already there get the share's quantity. New cards are added.</span>"],
      ["all", `<b>Add everything</b><br><span class=\"hint\">For combining separate piles. Cards already there get the ${what}'s quantity added to theirs.</span>`]] });
  if (!res || res.choice === "cancel") return null;
  if (res.choice === "new") return createNew();
  const target = importTargets().find(t => t.id === res.target);
  if (!target) return null;
  save(K.lastTarget, target.id);
  if (res.choice === "merge") {
    const mode = res.mode || "update";
    const r = target.type === "c" ? mergeInto(target.obj, entries, asList ? "code" : kind, mode) : mergeIntoList(target.obj, entries, from, mode);
    if (target.type === "c") saveCollections(); else saveLists();
    setView(target.id); reportMerge(r, target);
    return null;
  }
  // replace: same collection/list (name, place), new contents
  if (target.type === "l") { target.obj.items = entries.map(e => toListItem(e, from)); saveLists(); setView(target.id); return target.obj; }
  const c = { id: hashStr(kind + title + Date.now()), title: target.title, kind: asList ? "code" : kind, created: Date.now(), entries };
  collections[collections.indexOf(target.obj)] = c; saveCollections(); setView("c:" + c.id);
  return c;
}
const addCollection = (title, kind, entries) => importCards(title, kind, entries, false);
const addListFromCode = (name, entries) => importCards(name, "code", entries, true);

// ------------------------------------------------------------------ lists
function newList(suggest = "") {
  const name = (prompt("Name for the new list (for example who you're trading with):", suggest) || "").trim();
  if (!name) return null;
  const l = { id: "l" + Date.now().toString(36), name, created: Date.now(), items: [] };
  lists.push(l); saveLists(); activeListId = l.id; save(K.active, activeListId);
  renderViewSelect(); renderActiveList();
  return l;
}
function setAside(entries, listId) {
  const v = currentView(); const l = lists.find(x => x.id === listId);
  if (!v || v.type !== "c" || !l || !entries.length) return;
  const owned = {};
  for (const e of v.entries) owned[itemKey(e)] = (owned[itemKey(e)] || 0) + e.qty;
  let added = 0, full = 0;
  for (const e of entries) {
    const ik = itemKey(e), max = owned[ik] || e.qty;
    const it = l.items.find(x => itemKey(x) === ik);
    if (it) { it.owned = max; if (it.qty < max) { it.qty++; added++; } else full++; }
    else {
      l.items.push({ k: e.k, set: e.set, cn: e.cn, finish: e.finish, name: nameOf(e), sid: e.sid || "",
        setName: e.setName || cardFor(e)?.set_name || "", rarity: e.rarity || cardFor(e)?.rarity || "",
        binder: e.binder || "", condition: e.condition || "", language: e.language || "",
        qty: 1, owned: max, from: v.title });
      added++;
    }
  }
  activeListId = l.id; save(K.active, activeListId); saveLists();
  renderViewSelect(); renderActiveList();
  toast(`Set aside ${added} card${added === 1 ? "" : "s"} to “${l.name}” (${cardCount(l.items)} in list).` +
        (full ? ` ${full} skipped: all copies already set aside.` : ""));
}
function changeQty(entries, delta) {
  const v = currentView(); if (!v || v.type !== "l") return;
  for (const e of entries) {
    const it = v.obj.items.find(x => itemKey(x) === itemKey(e)); if (!it) continue;
    if (delta === null || it.qty + delta <= 0) v.obj.items = v.obj.items.filter(x => x !== it);
    else it.qty = Math.min(it.qty + delta, Math.max(it.owned || it.qty + delta, 1));
    selected.delete(e.uid);
  }
  saveLists(); setView(viewId);
}
/** Remove cards from the collection being viewed, after confirmation (Cancel is the default). Undo is offered afterwards. */
async function removeFromCollection(entries) {
  const v = currentView(); if (!v || v.type !== "c" || !entries.length) return;
  const col = v.obj, one = entries.length === 1, e0 = entries[0], n = cardCount(entries);
  const copies = q => `${q} ${q === 1 ? "copy" : "copies"}`;
  const desc = e => `${nameOf(e)} (${e.set.toUpperCase()} #${e.cn}${e.finish !== "normal" ? ", " + e.finish : ""}${e.binder ? `, binder “${e.binder}”` : ""})`;
  const names = entries.slice(0, 8).map(e => `• ${desc(e)}${e.qty > 1 ? " ×" + e.qty : ""}`).join("\n") + (entries.length > 8 ? `\n… and ${entries.length - 8} more` : "");
  const text = (one ? `Remove ${desc(e0)} from “${v.title}”? The collection has ${copies(e0.qty)} of it.`
                    : `Remove these ${entries.length} entries (${n} cards) from “${v.title}”?\n\n${names}`) +
    "\n\nThis only changes the collection on this site, not in ManaBox. If you later merge a ManaBox export that still has these cards, they're added back." +
    "\nLists you've set cards aside to are not changed.";
  const buttons = [["cancel", "Cancel", true]];
  if (entries.some(e => e.qty > 1)) buttons.push(["one", one ? "Remove 1 copy" : "Remove 1 copy of each"]);
  buttons.push(["all", one ? (e0.qty > 1 ? `Remove all ${e0.qty} copies` : "Remove") : `Remove all ${n} cards`]);
  const choice = await askChoice(one ? "Remove from collection?" : `Remove ${entries.length} entries from collection?`, text, buttons);
  if (!choice) return;
  const before = JSON.stringify(col.entries), targets = new Set(entries);
  let removed = 0;
  if (choice === "one") {
    for (const e of targets) { e.qty -= 1; removed++; }
    col.entries = col.entries.filter(e => e.qty > 0);
  } else {
    removed = n; col.entries = col.entries.filter(e => !targets.has(e));
  }
  saveCollections(); setView(viewId);
  toast(`Removed ${removed} card${removed === 1 ? "" : "s"} from “${col.title}”.`, 10000, ["Undo", () => {
    col.entries = JSON.parse(before); saveCollections(); setView("c:" + col.id); toast("Removal undone.");
  }]);
}
const selectedEntries = () => { const v = currentView(); return v ? v.entries.filter(e => selected.has(e.uid)) : []; };

// ------------------------------------------------------------------ filtering / sorting
function colorRank(ci) {
  if (!ci.length) return [6, ""];
  if (ci.length === 1) return [COLORS.indexOf(ci[0]), ""];
  return [5, [...ci].sort((a, b) => COLORS.indexOf(a) - COLORS.indexOf(b)).join("")];
}
function typeRank(tl) { const front = (tl || "").split("//")[0]; const i = TYPES.findIndex(t => front.includes(t)); return i < 0 ? TYPES.length : i; }
function sortKey(e) {
  const c = cardFor(e) || {}, n = nameOf(e).toLowerCase();
  switch (F.sort) {
    case "ci": return [...colorRank(c.color_identity || []), n];
    case "cmc": return [c.cmc || 0, n];
    case "rarity": return [RARITY_ORDER[e.rarity || c.rarity] ?? 9, n];
    case "price": { const [p] = priceOf(e); return [p ?? -1, n]; }
    case "set": return [(e.setName || c.set_name || e.set).toLowerCase(), ...cnKey(e.cn)];
    case "type": return [typeRank(c.type_line), n];
    case "qty": return [e.qty, n];
    default: return [n];
  }
}
function matches(e) {
  const c = cardFor(e) || {};
  if (F.want && !nameKeys(nameOf(e)).some(k => F.want.has(k))) return false;
  if (F.set && e.set !== F.set) return false;
  if (F.binder && (e.binder || "") !== F.binder) return false;
  if (F.foil && e.finish === "normal") return false;
  if (F.rar.size && !F.rar.has(e.rarity || c.rarity)) return false;
  if (F.type && !(c.type_line || "").includes(F.type)) return false;
  if (F.kw && !(c.keywords || []).includes(F.kw)) return false;
  if (F.colors.size) {
    const ci = new Set(c.color_identity || []), want = new Set([...F.colors].filter(x => x !== "C")), cl = F.colors.has("C");
    if (F.mode === "any") { if (!([...ci].some(x => want.has(x)) || (cl && !ci.size))) return false; }
    else if (F.mode === "within") { if (![...ci].every(x => want.has(x))) return false; }
    else if (cl && !want.size) { if (ci.size) return false; }
    else if (ci.size !== want.size || ![...ci].every(x => want.has(x))) return false;
  }
  if (F.q) {
    const hay = [nameOf(e), e.set, e.setName, c.set_name, c.type_line, c.oracle_text, (c.keywords || []).join(" ")].join(" ").toLowerCase();
    if (!F.q.toLowerCase().split(/\s+/).every(w => hay.includes(w))) return false;
  }
  return true;
}
function visibleEntries() {
  const v = currentView(); if (!v) return [];
  return v.entries.filter(matches).sort((a, b) => cmp(sortKey(a), sortKey(b)) * (F.asc ? 1 : -1));
}

// ------------------------------------------------------------------ rendering
function fillSelect(sel, allLabel, items, current) {
  sel.innerHTML = ""; sel.add(new Option(allLabel, ""));
  for (const [label, value] of items) sel.add(new Option(label, value));
  sel.value = items.some(([, v]) => v === current) ? current : "";
  return sel.value;
}
function renderFilterOptions() {
  const v = currentView(), entries = v ? v.entries : [];
  const sets = new Map(), kws = new Map(), binders = new Map();
  for (const e of entries) {
    const c = cardFor(e);
    const s = sets.get(e.set) || [e.setName || c?.set_name || e.set.toUpperCase(), 0]; s[1] += e.qty; sets.set(e.set, s);
    for (const k of c?.keywords || []) kws.set(k, (kws.get(k) || 0) + e.qty);
    if (e.binder) binders.set(e.binder, (binders.get(e.binder) || 0) + e.qty);
  }
  F.set = fillSelect($("#fSet"), "All sets", [...sets].sort((a, b) => a[1][0].localeCompare(b[1][0]))
    .map(([code, [name, n]]) => [`${name} (${code.toUpperCase()}) · ${n}`, code]), F.set);
  F.kw = fillSelect($("#fKeyword"), "Any keyword", [...kws].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => [`${k} · ${n}`, k]), F.kw);
  F.binder = fillSelect($("#fBinder"), "All binders", [...binders].sort().map(([b, n]) => [`${b} · ${n}`, b]), F.binder);
  $("#binderRow").hidden = binders.size < 2;
}
function renderViewSelect() {
  const sel = $("#viewSelect"); sel.innerHTML = "";
  if (!collections.length && !lists.length) { sel.add(new Option("Nothing imported yet", "")); sel.disabled = true; }
  else {
    sel.disabled = false;
    const gc = document.createElement("optgroup"); gc.label = "Collections";
    for (const c of collections) gc.append(new Option(`${c.title} (${cardCount(c.entries)})`, "c:" + c.id));
    const gl = document.createElement("optgroup"); gl.label = "My lists";
    for (const l of lists) gl.append(new Option(`${l.name} (${cardCount(l.items)})`, "l:" + l.id));
    if (collections.length) sel.append(gc);
    if (lists.length) sel.append(gl);
    sel.value = viewId;
  }
  const v = currentView();
  $("#renameView").disabled = $("#deleteView").disabled = !v;
  $("#shareBtn").disabled = !v;
}
function renderActiveList() {
  const sel = $("#activeList"); sel.innerHTML = "";
  for (const l of lists) sel.add(new Option(`${l.name} (${cardCount(l.items)})`, l.id));
  sel.add(new Option("New list…", "__new"));
  if (!lists.some(l => l.id === activeListId)) activeListId = lists[0]?.id || "";
  sel.value = activeListId || "__new";
  const v = currentView();
  $("#setAsideBox").hidden = !v || v.type !== "c";
  $("#listBox").hidden = !v || v.type !== "l";
}
/** Value of entries: Cardmarket trend in EUR; cards with no EUR price fall back to USD and are summed separately. */
function valueOf(entries) {
  let eur = 0, usd = 0, missing = 0, hasPaid = false, paidNow = 0, paidThen = 0;
  const paid = {};   // price when added (ManaBox purchase price), per currency
  for (const e of entries) {
    const [p, cur] = priceOf(e);
    if (p === null) missing += e.qty; else if (cur === "eur") eur += p * e.qty; else usd += p * e.qty;
    if (e.paid != null) {
      const pc = (e.paidCur || "EUR").toUpperCase();
      paid[pc] = (paid[pc] || 0) + e.paid * e.qty; hasPaid = true;
      if (p !== null && cur === pc.toLowerCase()) { paidNow += p * e.qty; paidThen += e.paid * e.qty; }   // same currency: comparable
    }
  }
  return { eur, usd, missing, paid, hasPaid, paidDiff: paidNow - paidThen };
}
const curSym = c => ({ EUR: "€", USD: "$", GBP: "£" })[(c || "").toUpperCase()] ?? (c ? c.toUpperCase() + " " : "");
const fmtMoney = (n, c) => (n < 0 ? "−" : "") + curSym(c) + Math.abs(n).toFixed(2);
const signedMoney = (n, c) => (n > 0.005 ? "+" : n < -0.005 ? "−" : "±") + curSym(c) + Math.abs(n).toFixed(2);
/** "value when added €2373.16 (+€2.54 since)"; the change compares only cards priced in the same currency then and now. */
function fmtPaid(v) {
  const curs = Object.keys(v.paid).sort((a, b) => (b === "EUR") - (a === "EUR"));
  const main = curs[0] || "EUR";
  return "value when added " + curs.map(c => fmtMoney(v.paid[c], c)).join(" + ") + ` (${signedMoney(v.paidDiff, main)} since)`;
}
const fmtValue = v => `€${v.eur.toFixed(2)}` + (v.usd ? ` + $${v.usd.toFixed(2)}` : "");
function fmtTime(t) {
  const d = new Date(t), p = n => String(n).padStart(2, "0");
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** Oldest and newest time the shown cards' prices were fetched from Scryfall. */
function fetchedRange(entries) {
  let lo = Infinity, hi = 0;
  for (const e of entries) { const t = cardCache[e.k]?.t; if (t) { lo = Math.min(lo, t); hi = Math.max(hi, t); } }
  return hi ? [lo, hi] : null;
}
function renderStats(shown) {
  const v = currentView();
  if (!v) { $("#stats").textContent = ""; $("#priceNote").hidden = true; return; }
  const all = valueOf(v.entries), vis = valueOf(shown), filtered = shown.length < v.entries.length;
  const label = v.type === "c" ? "collection" : "list";
  const parts = [`${shown.length} of ${v.entries.length} entries`, `${cardCount(shown)} cards`];
  parts.push(filtered ? `shown ${fmtValue(vis)} · whole ${label} ${fmtValue(all)}` : `${label} value ${fmtValue(all)}`);
  if (all.hasPaid && v.type === "c") parts.push(fmtPaid(filtered ? vis : all));
  if (selected.size) parts.push(`${selected.size} selected`);
  $("#stats").textContent = parts.join(" · ");
  const ch = changeOf(v.entries), chEl = $("#priceChange");
  if (ch) {
    const sign = ch.diff > 0.005 ? "+" : ch.diff < -0.005 ? "−" : "±";
    chEl.innerHTML = ` · <span class="${ch.diff > 0.005 ? "up" : ch.diff < -0.005 ? "down" : ""}">${sign}€${Math.abs(ch.diff).toFixed(2)}</span> since the previous prices (${fmtTime(ch.since)}, ${ch.n} card${ch.n === 1 ? "" : "s"})`;
  } else chEl.textContent = "";
  const r = fetchedRange(v.entries), note = $("#priceNote");
  note.hidden = !r;
  if (r) {
    const when = fmtTime(r[0]) === fmtTime(r[1]) ? fmtTime(r[1]) : `${fmtTime(r[0])} – ${fmtTime(r[1])}`;
    $("#priceWhen").textContent = `Cardmarket trend prices via Scryfall, fetched ${when}` +
      (all.missing ? ` · ${all.missing} card${all.missing === 1 ? "" : "s"} without a price` : "") +
      (all.usd ? " · $ = no EUR price, USD shown" : "");
  }
}
function tileHTML(e, isList) {
  const c = cardFor(e), url = imageUrls(c)[0], [p, cur] = priceOf(e);
  const name = nameOf(e);
  const art = url
    ? `<img src="${esc(url)}" alt="${esc(name)}" loading="lazy" crossorigin="anonymous">`
    : `<div class="ph"><b>${esc(name)}</b><span>${esc(e.set.toUpperCase())} #${esc(e.cn)}</span>${e.notFound ? "<span>(not found on Scryfall)</span>" : ""}</div>`;
  const btns = isList
    ? `<button data-act="minus" title="One less">−</button><button data-act="plus" title="One more">+</button>`
    : "";   // collection: set aside from the card details, right-click menu or A
  return `<figure class="tile${selected.has(e.uid) ? " sel" : ""}" data-uid="${esc(e.uid)}">
    <div class="art">${art}${e.qty > 1 ? (q => `<span class="badge${q.length > 2 ? " l" + Math.min(q.length, 5) : ""}" role="img" aria-label="${e.qty} copies${isList && e.owned > e.qty ? ` of ${e.owned} owned` : ""}"><b>${q}</b></span>`)(`${e.qty}${isList && e.owned > e.qty ? "/" + e.owned : ""}`) : ""}${e.finish !== "normal" ? `<span class="foil">${e.finish.toUpperCase()}</span>` : ""}</div>
    <figcaption class="cap"><div class="meta"><div class="nm" title="${esc(name)}">${esc(name)}</div>
      <div class="sub"><span>${esc(e.set.toUpperCase())} #${esc(e.cn)}</span><span>${fmtPrice(p, cur)}</span></div></div>${btns}</figcaption></figure>`;
}
function renderGrid() {
  const v = currentView(), shown = visibleEntries();
  $("#wantChip").hidden = !F.want;
  $("#empty").hidden = !!v; $("#grid").hidden = !v;
  $("#grid").innerHTML = v ? shown.map(e => tileHTML(e, v.type === "l")).join("") : "";
  renderStats(shown);
}
function renderAll() { renderViewSelect(); renderActiveList(); renderFilterOptions(); renderGrid(); }

// ------------------------------------------------------------------ detail dialog
function openDetail(e) {
  const v = currentView(), c = cardFor(e), [p, cur] = priceOf(e);
  const blocks = c ? (c.faces.length ? c.faces : [c]) : [];
  const rows = [
    ["Set", `${esc(e.setName || c?.set_name || "")} (${esc(e.set.toUpperCase())}) #${esc(e.cn)}`],
    ["Rarity", esc(e.rarity || c?.rarity || "")], ["Finish", esc(e.finish)],
    v.type === "l" ? ["Set aside", `${e.qty} of ${e.owned} owned`] : ["Quantity", e.qty],
    ["Trend price", fmtPrice(p, cur) + (cardCache[e.k]?.t ? ` <span class="hint">(fetched ${fmtTime(cardCache[e.k].t)})</span>` : "")],
    ...(prevPriceOf(e) ? [["Previous price", `${fmtPrice(prevPriceOf(e).v, prevPriceOf(e).cur)} <span class="hint">(fetched ${fmtTime(prevPriceOf(e).t)})</span>`]] : []),
  ];
  if (e.from) rows.push(["From", esc(e.from)]);
  if (e.binder) rows.push(["Binder", esc(e.binder)]);
  if (e.condition) rows.push(["Condition", esc(e.condition.replace(/_/g, " "))]);
  if (e.language) rows.push(["Language", esc(e.language)]);
  if (e.paid != null) rows.push(["Price when added", `${esc(fmtMoney(e.paid, e.paidCur || "EUR"))} <span class="hint">(ManaBox's purchase price: the card's price on the day it was added, unless you entered your own)</span>`]);
  $("#detailBody").innerHTML = `<div class="imgs">${imageUrls(c, "large").map(u => `<img src="${esc(u)}" alt="" crossorigin="anonymous">`).join("")}</div>
    <div class="txt"><h3>${esc(nameOf(e))}</h3>
    ${blocks.map(b => `${c.faces.length ? `<b>${esc(b.name)}</b> ` : ""}${esc(b.mana_cost || "")}<br><i>${esc(b.type_line || "")}</i>
      <div class="oracle">${esc(b.oracle_text || "")}${b.power != null ? `\n${esc(b.power)}/${esc(b.toughness)}` : b.loyalty != null ? `\nLoyalty ${esc(b.loyalty)}` : ""}</div>`).join("")}
    ${!c ? `<p>${e.notFound ? "Not found on Scryfall." : "Card data not loaded yet."}</p>` : ""}
    <table>${rows.map(([k, val]) => `<tr><td>${k}</td><td>${val}</td></tr>`).join("")}</table>
    ${c?.artist ? `<p class="hint">Illustrated by ${esc(c.artist)}</p>` : ""}
    ${c?.uri ? `<p><a href="${esc(c.uri)}" target="_blank" rel="noopener">View on Scryfall</a></p>` : ""}</div>`;
  const act = $("#detailActions"); act.innerHTML = "";
  const btn = (label, fn, cls = "") => { const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; act.append(b); };
  if (v.type === "c") {
    const sel = document.createElement("select");
    for (const l of lists) sel.add(new Option(l.name, l.id));
    sel.add(new Option("New list…", "__new")); sel.value = activeListId || "__new";
    act.append(sel);
    btn("Set aside 1", () => {
      let id = sel.value;
      if (id === "__new") { const l = newList(); if (!l) return; id = l.id; }
      setAside([e], id); openDetail(e);
    }, "primary");
    btn("Remove from collection…", () => { closeDlg("#detailDlg"); removeFromCollection([e]); });
  } else {
    btn("− One less", () => { changeQty([e], -1); closeDlg("#detailDlg"); });
    btn("+ One more", () => { changeQty([e], +1); const it = currentView()?.entries.find(x => x.uid === e.uid); if (it) openDetail(it); });
    btn("Remove", () => { changeQty([e], null); closeDlg("#detailDlg"); });
  }
  const d = $("#detailDlg"); if (!d.open) d.showModal();
}
const closeDlg = s => { const d = $(s); if (d.open) d.close(); };

// ------------------------------------------------------------------ context menu
function showMenu(x, y, entries) {
  const v = currentView(); if (!v || !entries.length) return;
  const m = $("#ctxMenu"); m.innerHTML = "";
  const head = document.createElement("div"); head.className = "head";
  head.textContent = entries.length === 1 ? nameOf(entries[0]) : `${entries.length} cards`; m.append(head);
  const item = (label, hint, fn) => {
    const b = document.createElement("button"); b.innerHTML = `${esc(label)}${hint ? `<span>${esc(hint)}</span>` : ""}`;
    b.onclick = () => { hideMenu(); fn(); }; m.append(b);
  };
  if (v.type === "c") {
    const active = lists.find(l => l.id === activeListId);
    if (active) item(`Set aside to “${active.name}”`, "A", () => setAside(entries, active.id));
    for (const l of lists) if (l !== active) item(`Set aside to “${l.name}”`, "", () => setAside(entries, l.id));
    m.append(document.createElement("hr"));
    item("New list…", "", () => { const l = newList(); if (l) setAside(entries, l.id); });
    m.append(document.createElement("hr"));
    item("Remove from collection…", "Del", () => removeFromCollection(entries));
  } else {
    item("One more", "+", () => changeQty(entries, +1));
    item("One less", "−", () => changeQty(entries, -1));
    item("Remove from list", "Del", () => changeQty(entries, null));
  }
  if (entries.length === 1) { m.append(document.createElement("hr")); item("Details…", "", () => openDetail(entries[0])); }
  m.hidden = false; m.dataset.opened = Date.now();
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + "px";
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + "px";
}
const hideMenu = () => { $("#ctxMenu").hidden = true; };

// ------------------------------------------------------------------ grid interaction
function entryFromEl(el) {
  const fig = el.closest(".tile"); if (!fig) return null;
  return currentView()?.entries.find(e => e.uid === fig.dataset.uid) || null;
}
function toggleSelect(e, range) {
  if (range && lastClicked) {
    const vis = visibleEntries(); const a = vis.findIndex(x => x.uid === lastClicked), b = vis.findIndex(x => x.uid === e.uid);
    if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; for (let i = lo; i <= hi; i++) selected.add(vis[i].uid); }
  } else if (selected.has(e.uid)) selected.delete(e.uid); else selected.add(e.uid);
  lastClicked = e.uid;
  document.querySelectorAll(".tile").forEach(t => t.classList.toggle("sel", selected.has(t.dataset.uid)));
  renderStats(visibleEntries());
}
function targetEntries(e) { return selected.has(e.uid) ? selectedEntries() : [e]; }

function setupGrid() {
  const grid = $("#grid");
  let press = null, suppressClick = false;
  grid.addEventListener("click", ev => {
    if (suppressClick) { suppressClick = false; return; }
    const e = entryFromEl(ev.target); if (!e) return;
    const act = ev.target.closest("button")?.dataset.act;
    if (act === "aside") {
      if (!lists.some(l => l.id === activeListId)) { const l = newList(); if (!l) return; }
      setAside(targetEntries(e), activeListId);
    } else if (act === "plus") changeQty(targetEntries(e), +1);
    else if (act === "minus") changeQty(targetEntries(e), -1);
    else if (ev.target.closest(".art")) {
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey) toggleSelect(e, ev.shiftKey);
      else openDetail(e);
    }
  });
  grid.addEventListener("contextmenu", ev => {
    const e = entryFromEl(ev.target); if (!e) return;
    ev.preventDefault(); showMenu(ev.clientX, ev.clientY, targetEntries(e));
  });
  // long-press on touch screens opens the same menu
  grid.addEventListener("pointerdown", ev => {
    if (ev.pointerType !== "touch") return;
    const e = entryFromEl(ev.target); if (!e) return;
    press = setTimeout(() => { suppressClick = true; showMenu(ev.clientX, ev.clientY, targetEntries(e)); }, 550);
  });
  const cancel = () => clearTimeout(press);
  grid.addEventListener("pointerup", cancel); grid.addEventListener("pointermove", cancel); grid.addEventListener("pointercancel", cancel);

  document.addEventListener("click", ev => { if (!ev.target.closest("#ctxMenu")) hideMenu(); });
  // ignore the scroll that can arrive just after opening (e.g. the page settling after a long-press)
  addEventListener("scroll", () => { if (Date.now() - (+$("#ctxMenu").dataset.opened || 0) > 250) hideMenu(); }, { passive: true });
  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape") { hideMenu(); if (selected.size) { selected.clear(); renderGrid(); } }
    if (document.querySelector("dialog[open]") || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    const v = currentView(); if (!v || !selected.size) return;
    const sel = selectedEntries();
    if (v.type === "c" && ev.key.toLowerCase() === "a" && !ev.ctrlKey && !ev.metaKey) {
      ev.preventDefault();
      if (!lists.some(l => l.id === activeListId)) { if (!newList()) return; }
      setAside(sel, activeListId);
    } else if (v.type === "c" && (ev.key === "Delete" || ev.key === "Backspace")) {
      ev.preventDefault(); removeFromCollection(sel);
    } else if (v.type === "l") {
      if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); changeQty(sel, null); }
      else if (ev.key === "+") changeQty(sel, +1);
      else if (ev.key === "-") changeQty(sel, -1);
    }
  });
}

// ------------------------------------------------------------------ importing
async function importFile(file) {
  const msg = $("#importMsg");
  const isImage = file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
  try {
    if (isImage) await importImage(file);
    else if (/\.json$/i.test(file.name) || file.type === "application/json") { closeDlg("#importDlg"); await restoreBackup(file); return; }
    else {
      const entries = csvToEntries(await file.text());
      if (await addCollection(file.name.replace(/\.csv$/i, ""), "csv", entries)) toast(`Imported ${entries.length} entries (${cardCount(entries)} cards).`);
    }
    closeDlg("#importDlg"); msg.textContent = "";
  } catch (err) {
    msg.textContent = err.message; msg.className = "msg err";
    if (!$("#importDlg").open) toast(err.message, 6000);
  }
}
async function importImage(blob) {
  toast("Reading QR code…", 20000);
  let texts;
  try { texts = await readQRTexts(blob); }
  catch (err) { console.error(err); throw new Error("Could not read that image."); }
  const { codes, missing } = assembleCodes(texts);
  if (!codes.length) throw new Error(missing.length ? `Incomplete: ${missing.join(", ")}. Use the full share image.` : "No Binder Share QR code found in that image.");
  for (const code of codes) await importCode(code);
}
async function importCode(code) {
  const { title, entries, kind } = await decodeCode(code);
  const done = kind === "list" ? await addListFromCode(title, entries) : await addCollection(title, "code", entries);
  if (done) toast(`Imported ${kind === "list" ? "list" : ""} “${title}”: ${cardCount(entries)} cards.`.replace("  ", " "));
}
async function importText(text) {
  const { codes, missing } = assembleCodes([text]);
  if (!codes.length) throw new Error(missing.length ? "That is only part of a multi-part code." : "No Binder Share code found in the text.");
  for (const c of codes) await importCode(c);
}

function setupImport() {
  const open = () => { $("#importMsg").textContent = ""; $("#codeInput").value = ""; $("#importDlg").showModal(); };
  $("#importBtn").onclick = open; $("#emptyImport").onclick = open;
  $("#pickFile").onclick = () => $("#fileInput").click();
  $("#fileInput").onchange = ev => { const f = ev.target.files[0]; ev.target.value = ""; if (f) importFile(f); };
  $("#importCode").onclick = async () => {
    try { await importText($("#codeInput").value); closeDlg("#importDlg"); }
    catch (err) { $("#importMsg").textContent = err.message; $("#importMsg").className = "msg err"; }
  };
  const dz = $("#dropZone");
  dz.addEventListener("dragover", ev => { ev.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("over"));

  // drop anywhere on the page
  // dragover fires continuously while a file is over the page, so the overlay hides itself once it stops
  const ov = $("#dropOverlay"); let ovTimer;
  addEventListener("dragover", ev => {
    ev.preventDefault();
    if (!ev.dataTransfer?.types.includes("Files")) return;
    ov.hidden = false; clearTimeout(ovTimer); ovTimer = setTimeout(() => { ov.hidden = true; dz.classList.remove("over"); }, 200);
  });
  addEventListener("drop", ev => {
    ev.preventDefault(); clearTimeout(ovTimer); ov.hidden = true; dz.classList.remove("over");
    const f = ev.dataTransfer?.files?.[0]; if (f) importFile(f);
  });
  // paste an image (or a code) anywhere
  document.addEventListener("paste", async ev => {
    const items = [...(ev.clipboardData?.items || [])];
    const img = items.find(i => i.type.startsWith("image/"));
    if (img) { ev.preventDefault(); importFile(img.getAsFile()); return; }
    const inField = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
    const text = ev.clipboardData?.getData("text") || "";
    if (!inField && /MTG1[:-]/.test(text)) { ev.preventDefault(); importText(text).catch(err => toast(err.message, 6000)); }
  });
}

// ------------------------------------------------------------------ share image
const imgCache = new Map();
function loadImage(url) {
  if (!imgCache.has(url)) imgCache.set(url, new Promise(res => {
    const im = new Image(); im.crossOrigin = "anonymous";
    const timer = setTimeout(() => res(null), 20000);
    im.onload = () => { clearTimeout(timer); res(im); }; im.onerror = () => { clearTimeout(timer); res(null); };
    im.src = url;
  }));
  return imgCache.get(url);
}
function makeQR(text) { const qr = qrcode(0, "L"); qr.addData(text, "Byte"); qr.make(); return qr; }
function drawQR(ctx, qr, x, y, cell) {
  const n = qr.getModuleCount(), quiet = 4 * cell, size = n * cell + quiet * 2;
  ctx.fillStyle = "#fff"; ctx.fillRect(x, y, size, size); ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(x + quiet + c * cell, y + quiet + r * cell, cell, cell);
  return size;
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
function ellipsize(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  while (text.length > 1 && ctx.measureText(text + "…").width > max) text = text.slice(0, -1);
  return text + "…";
}

async function drawSheet(canvas, { title, entries, code, cols, prices, pics }) {
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const pad = 28, gap = 14, cardW = 200, cardH = Math.round(cardW * 680 / 488), capH = 42;
  const qrs = qrTexts(code).map(makeQR);
  const cell = Math.max(3, Math.min(6, Math.floor(260 / qrs[0].getModuleCount())));
  const qrSizes = qrs.map(q => (q.getModuleCount() + 8) * cell);
  const qrW = qrSizes.reduce((a, b) => a + b, 0) + gap * (qrs.length - 1), qrH = Math.max(...qrSizes);
  const n = entries.length;
  cols = Math.max(1, Math.min(cols, n));
  const textCols = Math.max(2, Math.min(5, Math.ceil(n / 60))), lineH = 20, textColW = 320;   // text mode: wide rather than very tall
  const bodyW = pics ? cols * cardW + (cols - 1) * gap : textCols * textColW;
  const width = Math.max(pad * 2 + bodyW, pad * 2 + 420 + gap + qrW);
  const headH = Math.max(110, qrH) + 20;
  const rows = pics ? Math.ceil(n / cols) : Math.ceil(n / textCols);
  const bodyH = pics ? rows * (cardH + capH) + (rows - 1) * gap : rows * lineH;
  const footH = 30, height = pad + headH + bodyH + footH + pad;
  if (height > 30000) throw new Error("Too many cards for one image. Filter the view down, or turn off card pictures.");

  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f4f3ef"; ctx.fillRect(0, 0, width, height);

  // header
  const [eur] = entries.reduce(([s], e) => { const [p, cur] = priceOf(e); return [s + (cur === "eur" && p !== null ? p * e.qty : 0)]; }, [0]);
  const textW = width - pad * 2 - qrW - gap;
  ctx.fillStyle = "#1d1d1f"; ctx.font = `700 28px ${FONT}`; ctx.textBaseline = "top";
  ctx.fillText(ellipsize(ctx, title, textW), pad, pad);
  ctx.fillStyle = "#55555a"; ctx.font = `15px ${FONT}`;
  const d = new Date(); const date = `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
  ctx.fillText(ellipsize(ctx, `${cardCount(entries)} cards · ${n} entries · ${date}` + (prices ? ` · ≈ €${eur.toFixed(2)} (Cardmarket trend via Scryfall)` : ""), textW), pad, pad + 42);
  ctx.fillText(ellipsize(ctx, qrs.length > 1 ? `Import all ${qrs.length} QR codes: drop or paste this image at` : "Import: drop or paste this image at", textW), pad, pad + 68);
  ctx.fillStyle = "#5a3ca0"; ctx.font = `600 15px ${FONT}`;
  ctx.fillText(ellipsize(ctx, shareBase(), textW), pad, pad + 90);
  let qx = width - pad - qrW;
  qrs.forEach((q, i) => { drawQR(ctx, q, qx, pad, cell); qx += qrSizes[i] + gap; });

  const top = pad + headH;
  if (pics) {
    const imgs = await Promise.all(entries.map(e => { const u = imageUrls(cardFor(e))[0]; return u ? loadImage(u) : null; }));
    entries.forEach((e, i) => {
      const x = pad + (i % cols) * (cardW + gap), y = top + Math.floor(i / cols) * (cardH + capH + gap);
      const r = cardW * 0.045;
      ctx.save(); roundRect(ctx, x, y, cardW, cardH, r); ctx.clip();
      if (imgs[i]) ctx.drawImage(imgs[i], x, y, cardW, cardH);
      else {
        ctx.fillStyle = "#dcdad3"; ctx.fillRect(x, y, cardW, cardH);
        ctx.fillStyle = "#333"; ctx.font = `600 14px ${FONT}`; ctx.textAlign = "center";
        ctx.fillText(ellipsize(ctx, nameOf(e), cardW - 16), x + cardW / 2, y + cardH / 2 - 8); ctx.textAlign = "left";
      }
      ctx.restore();
      ctx.font = `700 13px ${FONT}`;
      if (e.qty > 1) {
        ctx.fillStyle = "rgba(0,0,0,.82)"; roundRect(ctx, x + cardW - 48, y + 10, 40, 24, 12); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.fillText(`×${e.qty}`, x + cardW - 28, y + 15); ctx.textAlign = "left";
      }
      if (e.finish !== "normal") {
        ctx.fillStyle = "rgba(90,60,160,.94)"; roundRect(ctx, x + 8, y + cardH - 32, 64, 24, 12); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.fillText(e.finish.toUpperCase(), x + 40, y + cardH - 27); ctx.textAlign = "left";
      }
      ctx.fillStyle = "#1d1d1f"; ctx.font = `700 13px ${FONT}`;
      ctx.fillText(ellipsize(ctx, nameOf(e), cardW), x, y + cardH + 5);
      ctx.fillStyle = "#55555a"; ctx.font = `13px ${FONT}`;
      ctx.fillText(`${e.set.toUpperCase()} #${e.cn}`, x, y + cardH + 23);
      if (prices) { const [p, cur] = priceOf(e); ctx.textAlign = "right"; ctx.fillText(fmtPrice(p, cur), x + cardW, y + cardH + 23); ctx.textAlign = "left"; }
    });
  } else {
    ctx.font = `14px ${FONT}`;
    entries.forEach((e, i) => {
      const x = pad + Math.floor(i / rows) * textColW, y = top + (i % rows) * lineH;
      const [p, cur] = priceOf(e);
      const line = `${e.qty}× ${nameOf(e)} (${e.set.toUpperCase()} ${e.cn})${e.finish !== "normal" ? " " + e.finish : ""}`;
      ctx.fillStyle = "#1d1d1f"; ctx.fillText(ellipsize(ctx, line, textColW - (prices ? 76 : 14)), x, y);
      if (prices) { ctx.fillStyle = "#55555a"; ctx.textAlign = "right"; ctx.fillText(fmtPrice(p, cur), x + textColW - 14, y); ctx.textAlign = "left"; }
    });
  }
  ctx.fillStyle = "#8a8a90"; ctx.font = `12px ${FONT}`; ctx.textAlign = "center";
  ctx.fillText("Card images via Scryfall · Magic: The Gathering © Wizards of the Coast", width / 2, height - pad - 14);
  ctx.textAlign = "left";
}

/** Just the QR code(s) with a title: the smallest image to share. */
function drawQROnly(canvas, { title, entries, code }) {
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const qrs = qrTexts(code).map(makeQR), pad = 24, gap = 16;
  const cell = Math.max(3, Math.min(8, Math.floor(420 / qrs[0].getModuleCount())));
  const sizes = qrs.map(q => (q.getModuleCount() + 8) * cell);
  const qrW = sizes.reduce((a, b) => a + b, 0) + gap * (qrs.length - 1);
  const width = Math.max(qrW + pad * 2, 360), height = pad + 64 + Math.max(...sizes) + 34 + pad;
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = "top"; ctx.textAlign = "center";
  ctx.fillStyle = "#1d1d1f"; ctx.font = `700 22px ${FONT}`;
  ctx.fillText(ellipsize(ctx, title, width - pad * 2), width / 2, pad);
  const d = new Date();
  ctx.fillStyle = "#55555a"; ctx.font = `14px ${FONT}`;
  ctx.fillText(ellipsize(ctx, `${cardCount(entries)} cards · ${entries.length} entries · ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`, width - pad * 2), width / 2, pad + 32);
  let x = (width - qrW) / 2;
  qrs.forEach((q, i) => { drawQR(ctx, q, x, pad + 60, cell); x += sizes[i] + gap; });
  ctx.fillStyle = "#5a3ca0"; ctx.font = `600 13px ${FONT}`;
  ctx.fillText(ellipsize(ctx, (qrs.length > 1 ? `Import all ${qrs.length} codes at ` : "Open or import at ") + shareBase(), width - pad * 2),
               width / 2, height - pad - 18);
  ctx.textAlign = "left";
}

let shareState = null;
const MODE_HELP = {
  sheet: "An image of the cards with the QR code in the corner. People see the cards; the site imports them from the same image.",
  qr: "Only the QR code. Drop or paste the image on the site to import, or scan it with a phone camera to open the cards.",
  text: "The link opens the site with these cards. The code can be pasted into Import. Chat apps may cut off very long links.",
};
async function refreshShare() {
  const s = shareState; if (!s) return;
  const title = $("#shareTitle").value.trim() || s.defaultTitle;
  const cols = Math.max(2, Math.min(12, parseInt($("#shareCols").value, 10) || 6));
  const pics = $("#sharePics").checked && s.entries.length <= SHEET_MAX_PICS;
  const mode = s.mode;
  document.querySelectorAll("#shareDlg .seg button").forEach(b => b.setAttribute("aria-selected", b.dataset.mode === mode));
  $("#modeHelp").textContent = MODE_HELP[mode];
  $("#sheetOpts").hidden = mode !== "sheet";
  $("#imgWrap").hidden = mode === "text"; $("#textWrap").hidden = mode !== "text";
  $("#copyImg").hidden = $("#downloadImg").hidden = mode === "text";
  const token = s.token = Symbol();
  say(mode === "text" ? "" : "Drawing…");
  try {
    const code = await encodeCode(title, s.entries, currentView()?.type === "l" ? "list" : "collection");
    if (token !== s.token) return;
    s.code = code; s.title = title; s.link = shareBase() + "#" + code;
    const nq = qrTexts(code).length;
    $("#shareInfo").textContent = `${s.entries.length} entries · ${cardCount(s.entries)} cards · ${nq} QR code${nq > 1 ? "s" : ""}`;
    $("#linkOut").value = s.link; $("#codeOut").value = code;
    if (mode === "text") fitCodeBox();
    if (mode === "sheet") {
      await drawSheet($("#sheet"), { title, entries: s.entries, code, cols, prices: $("#sharePrices").checked, pics });
      if (s.entries.length > SHEET_MAX_PICS && token === s.token) say(`Over ${SHEET_MAX_PICS} entries, so the sheet lists the cards as text.`);
      else if (token === s.token) say("");
    } else if (mode === "qr") { drawQROnly($("#sheet"), { title, entries: s.entries, code }); say(""); }
    else if (s.link.length > 2000) say(`This link is ${s.link.length} characters; some chat apps cut long messages. The QR image is safer.`);
  } catch (err) {
    if (token === s.token) say(err.message, true);
  }
}
/** Show the whole code without dragging: grow the field to its content, up to about half the screen (then it scrolls). */
function fitCodeBox() {
  const ta = $("#codeOut"); ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight + 2, Math.round(innerHeight * 0.5)) + "px";
}
function say(m, err) { $("#shareMsg").textContent = m; $("#shareMsg").className = "msg grow" + (err ? " err" : ""); }
function canvasBlob() {
  return new Promise((res, rej) => {
    try { $("#sheet").toBlob(b => b ? res(b) : rej(new Error("Could not create the image.")), "image/png"); }
    catch { rej(new Error("The browser blocked exporting card pictures. Turn off “Card pictures” and try again.")); }
  });
}
async function copyText(text, what) {
  try { await navigator.clipboard.writeText(text); say(`${what} copied.`); }
  catch { say("Copying was blocked by the browser: select the text and copy it manually.", true); }
}
function setupShare() {
  let t;
  const redraw = () => { clearTimeout(t); t = setTimeout(refreshShare, 300); };
  ["#shareTitle", "#shareCols", "#sharePrices", "#sharePics"].forEach(s => $(s).addEventListener("input", redraw));
  document.querySelectorAll("#shareDlg .seg button").forEach(b => {
    b.onclick = () => { shareState.mode = b.dataset.mode; refreshShare(); };
  });
  $("#shareBtn").onclick = () => {
    const v = currentView(); const entries = visibleEntries();
    if (!v || !entries.length) { toast("No cards are shown with the current filters."); return; }
    shareState = { entries, defaultTitle: v.title, mode: shareState?.mode || "sheet" };
    $("#shareTitle").value = v.title;
    $("#sharePics").checked = entries.length <= SHEET_MAX_PICS; $("#sharePics").disabled = entries.length > SHEET_MAX_PICS;
    say("");
    $("#shareDlg").showModal(); refreshShare();
  };
  $("#copyImg").onclick = async () => {
    try { const b = await canvasBlob(); await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]); say("Image copied: paste it into a chat."); }
    catch (err) { say(err.message.includes("blocked") ? err.message : "Your browser didn't allow copying images; use Download PNG.", true); }
  };
  $("#downloadImg").onclick = async () => {
    try {
      const b = await canvasBlob(); const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = (shareState.title || "cards").replace(/[\\/:*?"<>|]+/g, "_") + (shareState.mode === "qr" ? " QR" : "") + ".png";
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); say("Saved.");
    } catch (err) { say(err.message, true); }
  };
  $("#copyLink").onclick = () => copyText(shareState.link, "Link");
  $("#copyCode").onclick = () => copyText(shareState.code, "Code");
  $("#linkOut").onfocus = ev => ev.target.select();
  $("#codeOut").onfocus = ev => ev.target.select();
}


// ------------------------------------------------------------------ compare a want list
/** Normalize a card name for matching: case, accents, apostrophes and spacing don't matter. */
function normName(s) {
  return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[’‘`´]/g, "'").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}
/** Keys a name can match on: the full name, and each face of a double-faced / split card. */
function nameKeys(name) {
  const full = normName(name), keys = [full];
  if (full.includes("//")) for (const part of full.split("//")) keys.push(part.trim());
  return keys;
}
/** Parses Cardmarket's copied format (quantity line, then name line) as well as "2 Name", "2x Name" or just "Name". */
function parseWantList(text) {
  const out = new Map(); let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    if (/^\d+\s*x?$/i.test(line)) { pending = parseInt(line, 10); continue; }
    let qty = pending ?? 1, name = line;
    const m = /^(\d+)\s*x?\s+(.+)$/i.exec(line);
    if (m && pending === null) { qty = parseInt(m[1], 10); name = m[2]; }
    pending = null;
    name = name.trim();
    if (!name || qty <= 0) continue;
    // Cardmarket adds a version marker, e.g. "Stock Up (V.1)". Some real names end in brackets
    // ("B.F.M. (Big Furry Monster)"), so the stripped form is only a fallback key.
    const stripped = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
    const k = normName(name), prev = out.get(k);
    if (prev) prev.qty += qty; else out.set(k, { name, qty, key: k, alt: stripped && stripped !== name ? normName(stripped) : null });
  }
  return [...out.values()];
}
function compareWant(wants, entries) {
  const index = new Map();
  for (const e of entries) for (const k of new Set(nameKeys(nameOf(e)))) {
    if (!index.has(k)) index.set(k, []); index.get(k).push(e);
  }
  return wants.map(w => {
    const owned = index.get(w.key) || (w.alt && index.get(w.alt)) || [];
    const have = owned.reduce((s, e) => s + e.qty, 0);
    return { ...w, have, owned, status: have >= w.qty ? "have" : have > 0 ? "part" : "need" };
  });
}

let compareState = null;
function renderCompare() {
  const s = compareState, out = $("#compareOut");
  if (!s) { out.innerHTML = ""; return; }
  const rows = s.rows, by = st => rows.filter(r => r.status === st);
  const have = by("have"), part = by("part"), need = by("need");
  const toBuy = rows.reduce((n, r) => n + Math.max(0, r.qty - r.have), 0);
  const prints = r => r.owned.map(e => `${esc(e.set.toUpperCase())} #${esc(e.cn)}${e.finish !== "normal" ? " " + e.finish : ""}${e.qty > 1 ? " ×" + e.qty : ""}${e.binder ? " · " + esc(e.binder) : ""}`).join("<br>");
  const section = (label, list, cls) => !list.length ? "" :
    `<tr class="group"><td colspan="4"><span class="${cls}" style="border-radius:10px;padding:1px 8px">${label}</span> ${list.length}</td></tr>` +
    list.map(r => `<tr><td>${esc(r.owned[0] ? nameOf(r.owned[0]) : r.name)}</td><td class="num">${r.qty}</td><td class="num">${r.have}</td>
      <td class="prints">${r.owned.length ? prints(r) : "–"}</td></tr>`).join("");
  out.innerHTML = `<div class="cmp-sum">
      <span class="st-have">Already have: ${have.length}</span><span class="st-part">Partly: ${part.length}</span>
      <span class="st-need">Need to buy: ${need.length}</span></div>
    <p class="hint">${rows.length} different cards on the list · ${toBuy} cop${toBuy === 1 ? "y" : "ies"} still to buy · matched by card name, any printing or finish, against “${esc(s.against)}”.</p>
    <table class="cmp-table"><thead><tr><th>Card</th><th class="num">Want</th><th class="num">Have</th><th>Your copies</th></tr></thead>
    <tbody>${section("Need to buy", need, "st-need")}${section("Partly", part, "st-part")}${section("Already have", have, "st-have")}</tbody></table>`;
  $("#copyToBuy").disabled = !toBuy;
  $("#showOwned").disabled = $("#asideOwned").disabled = !(have.length + part.length);
}
async function runCompare() {
  const msg = $("#compareMsg"); msg.className = "msg"; msg.textContent = "";
  const wants = parseWantList($("#wantInput").value);
  if (!wants.length) { msg.textContent = "Paste a want list first."; msg.className = "msg err"; return; }
  save(K.want, $("#wantInput").value);
  const col = collections.find(c => c.id === $("#wantAgainst").value);
  if (!col) { msg.textContent = "Import a collection to compare against."; msg.className = "msg err"; return; }
  if (col.entries.some(e => !e.name && !cardFor(e))) {       // imported codes carry no names: load them first
    msg.textContent = "Loading card names from Scryfall…"; await fetchCards(col.entries); msg.textContent = "";
  }
  compareState = { rows: compareWant(wants, col.entries), against: col.title, colId: col.id };
  renderCompare();
}
function setupCompare() {
  $("#compareBtn").onclick = () => {
    const sel = $("#wantAgainst"); sel.innerHTML = "";
    for (const c of collections) sel.add(new Option(`${c.title} (${cardCount(c.entries)})`, c.id));
    const v = currentView();
    sel.value = v?.type === "c" ? v.obj.id : collections[0]?.id || "";
    if (!$("#wantInput").value) $("#wantInput").value = load(K.want, "");
    $("#compareMsg").textContent = collections.length ? "" : "Import a collection first: this compares a want list against it.";
    renderCompare(); $("#compareDlg").showModal();
  };
  $("#runCompare").onclick = runCompare;
  $("#wantAgainst").onchange = () => { if (compareState) runCompare(); };
  $("#copyToBuy").onclick = async () => {
    const lines = compareState.rows.filter(r => r.qty > r.have).map(r => `${r.qty - r.have} ${r.name}`);
    try { await navigator.clipboard.writeText(lines.join("\n")); $("#compareMsg").textContent = `Copied ${lines.length} line${lines.length === 1 ? "" : "s"}: paste them into your Cardmarket want list.`; }
    catch { $("#compareMsg").textContent = "Copying was blocked by the browser."; }
  };
  $("#showOwned").onclick = () => {
    const keys = new Set(compareState.rows.filter(r => r.have).map(r => r.key));
    closeDlg("#compareDlg");
    if (viewId !== "c:" + compareState.colId) setView("c:" + compareState.colId);
    F.want = keys; renderGrid();
  };
  $("#asideOwned").onclick = () => {
    const l = newList("Pull for want list"); if (!l) return;
    if (viewId !== "c:" + compareState.colId) setView("c:" + compareState.colId);
    // one set-aside per wanted copy, taken from your printings in order, up to the wanted quantity
    const picks = [];
    for (const r of compareState.rows) {
      let left = Math.min(r.qty, r.have);
      for (const e of r.owned) { const n = Math.min(left, e.qty); for (let i = 0; i < n; i++) picks.push(e); left -= n; if (!left) break; }
    }
    setAside(picks, l.id);
    closeDlg("#compareDlg");
  };
  $("#wantChipClear").onclick = () => { F.want = null; renderGrid(); };
}


// ------------------------------------------------------------------ export & backup
const csvCell = v => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvLine = arr => arr.map(csvCell).join(",");
const EXPORT = {
  manabox: { ext: "csv", mime: "text/csv", build(entries, title, v) {
    // same columns as ManaBox's own export
    const head = ["Binder Name", "Binder Type", "Name", "Set code", "Set name", "Collector number", "Foil", "Rarity", "Quantity",
      "ManaBox ID", "Scryfall ID", "Purchase price", "Misprint", "Altered", "Signed", "Condition", "Language", "Proxy", "Purchase price currency"];
    return [csvLine(head), ...entries.map(e => { const c = cardFor(e);
      return csvLine([v.type === "l" ? title : (e.binder || title), v.type === "l" ? "binder" : (e.binderType || "binder"), nameOf(e),
        (c?.set || e.set).toUpperCase(), e.setName || c?.set_name || "", c?.cn || e.cn, e.finish, e.rarity || c?.rarity || "", e.qty,
        "", e.sid || c?.id || "", v.type === "l" ? "" : (e.paid ?? ""), "false", "false", "false", e.condition || "near_mint",
        e.language || "en", "false", v.type === "l" ? "" : (e.paidCur || "")]); })].join("\n") + "\n";
  } },
  cardmarket: { ext: "txt", mime: "text/plain", build(entries) {
    // Cardmarket want lists are by card name: merge printings and finishes
    const by = new Map();
    for (const e of entries) { const n = nameOf(e); by.set(n, (by.get(n) || 0) + e.qty); }
    return [...by].map(([n, q]) => `${q} ${n}`).join("\n") + "\n";
  } },
  moxfield: { ext: "txt", mime: "text/plain", build(entries) {
    return entries.map(e => { const c = cardFor(e);
      return `${e.qty} ${nameOf(e)} (${(c?.set || e.set).toUpperCase()}) ${c?.cn || e.cn}${e.finish === "foil" ? " *F*" : e.finish === "etched" ? " *E*" : ""}`; }).join("\n") + "\n";
  } },
  csv: { ext: "csv", mime: "text/csv", build(entries) {
    return [csvLine(["Quantity", "Name", "Set code", "Set name", "Collector number", "Finish", "Rarity", "Trend price", "Currency"]),
      ...entries.map(e => { const c = cardFor(e), [p, cur] = priceOf(e);
        return csvLine([e.qty, nameOf(e), (c?.set || e.set).toUpperCase(), e.setName || c?.set_name || "", c?.cn || e.cn, e.finish,
          e.rarity || c?.rarity || "", p === null ? "" : p.toFixed(2), p === null ? "" : cur.toUpperCase()]); })].join("\n") + "\n";
  } },
};
function downloadText(text, filename, mime) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime + ";charset=utf-8" })); a.download = filename.replace(/[\\/:*?"<>|]+/g, "_");
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
let exportState = null;
function renderExport() {
  const s = exportState; if (!s) return;
  const fmt = document.querySelector('input[name="fmt"]:checked').value;
  s.fmt = fmt; s.text = EXPORT[fmt].build(s.entries, s.title, s.view);
  $("#exportOut").value = s.text; $("#exportMsg").textContent = "";
}
async function restoreBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast("That file isn't a Binder Share backup.", 6000); return; }
  if (data?.app !== "Binder Share" || !Array.isArray(data.collections) || !Array.isArray(data.lists)) { toast("That file isn't a Binder Share backup.", 6000); return; }
  const summary = `${data.collections.length} collection(s) and ${data.lists.length} list(s), saved ${new Date(data.exported).toLocaleString()}.`;
  const choice = await askChoice("Restore backup", `The backup has ${summary}\n\nMerge adds what you don't have yet (same-named items are kept as copies). Replace deletes everything currently in this browser first.`,
    [["merge", "Merge", true], ["replace", "Replace all"], [null, "Cancel"]]);
  if (!choice) return;
  if (choice === "replace") { collections = data.collections; lists = data.lists; }
  else {
    const titles = new Set(collections.map(c => c.title)), names = new Set(lists.map(l => l.name));
    for (const c of data.collections) {
      if (collections.some(x => x.id === c.id)) continue;
      c.title = uniqueName(c.title, titles); titles.add(c.title); collections.push(c);
    }
    for (const l of data.lists) {
      const same = lists.find(x => x.name === l.name);
      if (same && contentKey(same.items) === contentKey(l.items)) continue;
      if (lists.some(x => x.id === l.id)) l.id = "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      l.name = uniqueName(l.name, names); names.add(l.name); lists.push(l);
    }
  }
  if (data.want && !load(K.want, "")) save(K.want, data.want);
  saveCollections(); saveLists();
  closeDlg("#exportDlg");
  setView(currentView() ? viewId : collections[0] ? "c:" + collections[0].id : lists[0] ? "l:" + lists[0].id : "");
  toast(`Restored: now ${collections.length} collection(s) and ${lists.length} list(s).`, 5000);
}
function setupExport() {
  $("#exportBtn").onclick = () => {
    const v = currentView(), entries = visibleEntries();
    exportState = { view: v, entries, title: v?.title || "cards" };
    $("#exportWhat").textContent = v
      ? `Exports the ${entries.length} entr${entries.length === 1 ? "y" : "ies"} (${cardCount(entries)} cards) currently shown from ${v.type === "l" ? "the list" : "the collection"} “${v.title}”.`
      : "Nothing to export yet; you can still back up or restore below.";
    $("#exportCopy").disabled = $("#exportDownload").disabled = !v || !entries.length;
    $("#backupMsg").textContent = "";
    if (v) renderExport(); else $("#exportOut").value = "";
    $("#exportDlg").showModal();
  };
  document.querySelectorAll('input[name="fmt"]').forEach(r => r.addEventListener("change", renderExport));
  $("#exportCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(exportState.text); $("#exportMsg").textContent = "Copied."; }
    catch { $("#exportMsg").textContent = "Copying was blocked: select the text and copy it manually."; }
  };
  $("#exportDownload").onclick = () => {
    const f = EXPORT[exportState.fmt];
    downloadText(exportState.text, `${exportState.title} (${exportState.fmt}).${f.ext}`, f.mime);
    $("#exportMsg").textContent = "Saved.";
  };
  $("#backupBtn").onclick = () => {
    const strip = arr => arr.map(({ uid, notFound, ...e }) => e);
    const data = { app: "Binder Share", format: 1, version: APP_VERSION, exported: new Date().toISOString(),
      collections: collections.map(c => ({ ...c, entries: strip(c.entries) })), lists: lists.map(l => ({ ...l, items: strip(l.items) })),
      want: load(K.want, "") };
    const d = new Date(), p = n => String(n).padStart(2, "0");
    downloadText(JSON.stringify(data), `binder-share-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`, "application/json");
    $("#backupMsg").textContent = `Saved ${collections.length} collection(s) and ${lists.length} list(s).`;
  };
  $("#restoreBtn").onclick = () => $("#restoreInput").click();
  $("#restoreInput").onchange = ev => { const f = ev.target.files[0]; ev.target.value = ""; if (f) restoreBackup(f); };
}

// ------------------------------------------------------------------ setup
function setupFilters() {
  const pips = $("#pips");
  for (const c of COLORS + "C") {
    const b = document.createElement("button"); b.className = "pip"; b.textContent = c; b.type = "button";
    b.dataset.c = c; b.setAttribute("aria-pressed", "false");
    b.title = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green", C: "Colorless" }[c];
    b.onclick = () => { F.colors.has(c) ? F.colors.delete(c) : F.colors.add(c); b.classList.toggle("on"); b.setAttribute("aria-pressed", F.colors.has(c)); renderGrid(); };
    pips.append(b);
  }
  const rar = $("#rarities");
  for (const r of RARITIES) {
    const l = document.createElement("label"); l.className = "check";
    l.innerHTML = `<input type="checkbox" value="${r}"> ${r[0].toUpperCase() + r.slice(1)}`;
    l.querySelector("input").onchange = ev => { ev.target.checked ? F.rar.add(r) : F.rar.delete(r); renderGrid(); };
    rar.append(l);
  }
  fillSelect($("#fType"), "Any type", TYPES.map(t => [t, t]), "");
  let qt;
  $("#q").addEventListener("input", ev => { clearTimeout(qt); qt = setTimeout(() => { F.q = ev.target.value.trim(); renderGrid(); }, 150); });
  $("#sort").onchange = ev => { F.sort = ev.target.value; renderGrid(); };
  $("#sortDir").onclick = ev => { F.asc = !F.asc; ev.target.textContent = F.asc ? "↑" : "↓"; renderGrid(); };
  const bind = (sel, key) => { $(sel).onchange = ev => { F[key] = ev.target.value; renderGrid(); }; };
  bind("#fSet", "set"); bind("#fKeyword", "kw"); bind("#fType", "type"); bind("#fBinder", "binder"); bind("#colorMode", "mode");
  $("#fFoil").onchange = ev => { F.foil = ev.target.checked; renderGrid(); };
  $("#clearFilters").onclick = () => {
    Object.assign(F, { q: "", set: "", kw: "", type: "", binder: "", mode: "any", foil: false, want: null });
    F.colors.clear(); F.rar.clear();
    $("#q").value = ""; $("#fType").value = ""; $("#colorMode").value = "any"; $("#fFoil").checked = false;
    document.querySelectorAll(".pip").forEach(p => { p.classList.remove("on"); p.setAttribute("aria-pressed", "false"); });
    document.querySelectorAll("#rarities input").forEach(i => { i.checked = false; });
    renderFilterOptions(); renderGrid();
  };
  const zoom = $("#zoom"); zoom.value = load(K.zoom, 160);
  const applyZoom = () => document.documentElement.style.setProperty("--tile", zoom.value + "px");
  zoom.oninput = () => { applyZoom(); save(K.zoom, +zoom.value); }; applyZoom();
  $("#filtersToggle").onclick = ev => { ev.stopPropagation(); $("#sidebar").classList.toggle("open"); };
  document.addEventListener("click", ev => {
    if ($("#sidebar").classList.contains("open") && !ev.target.closest("#sidebar") && ev.target.id !== "filtersToggle") $("#sidebar").classList.remove("open");
  });
}
function setupViews() {
  $("#refreshPrices").onclick = async () => {
    const v = currentView(); if (!v || fetching) return;
    const before = fetchedRange(v.entries)?.[1] || 0;
    // Scryfall updates prices once a day, so refetching data younger than an hour gains nothing
    await fetchCards(v.entries, { force: true, olderThan: 3600e3 });
    renderAll();
    toast((fetchedRange(v.entries)?.[1] || 0) > before ? "Prices refreshed." : "Prices were fetched less than an hour ago; Scryfall updates them once a day.");
  };
  $("#viewSelect").onchange = ev => setView(ev.target.value);
  $("#activeList").onchange = ev => {
    if (ev.target.value === "__new") { if (!newList()) renderActiveList(); }
    else { activeListId = ev.target.value; save(K.active, activeListId); }
  };
  $("#renameView").onclick = () => {
    const v = currentView(); if (!v) return;
    const name = (prompt("New name:", v.title) || "").trim(); if (!name) return;
    if (v.type === "c") { v.obj.title = name; saveCollections(); } else { v.obj.name = name; saveLists(); }
    renderAll();
  };
  $("#deleteView").onclick = () => {
    const v = currentView(); if (!v) return;
    const what = v.type === "c" ? `the collection “${v.title}” from this browser` : `the list “${v.title}”`;
    if (!confirm(`Delete ${what}?`)) return;
    if (v.type === "c") { collections = collections.filter(c => c !== v.obj); saveCollections(); }
    else { lists = lists.filter(l => l !== v.obj); saveLists(); }
    const next = collections[0] ? "c:" + collections[0].id : lists[0] ? "l:" + lists[0].id : "";
    setView(next);
  };
  document.querySelectorAll("[data-close]").forEach(b => { b.onclick = () => b.closest("dialog").close(); });
  // Close on a click on the backdrop, but only if the press also started there: dragging a text selection or
  // a textarea's resize handle out of the dialog ends with a "click" on the dialog itself.
  document.querySelectorAll("dialog").forEach(d => {
    let downOnBackdrop = false;
    d.addEventListener("pointerdown", ev => { downOnBackdrop = ev.target === d; });
    d.addEventListener("click", ev => { if (ev.target === d && downOnBackdrop) d.close(); downOnBackdrop = false; });
  });
}

async function init() {
  $("#appVersion").textContent = `Version ${APP_VERSION}.`;
  // A stale cached copy of this file (or of index.html) would silently break newer buttons: say so instead.
  const pageVersion = document.querySelector('meta[name="app-version"]')?.content;
  if (pageVersion !== APP_VERSION) {
    toast("The site was just updated: reload the page (Ctrl+F5) to get the latest version.", 15000);
  }
  setupFilters(); setupViews(); setupGrid(); setupImport(); setupShare(); setupCompare(); setupExport();
  if (!currentView()) viewId = collections[0] ? "c:" + collections[0].id : lists[0] ? "l:" + lists[0].id : "";
  setView(viewId);
  // opened from a share link?
  if (/^#MTG1/.test(location.hash)) {
    const code = decodeURIComponent(location.hash.slice(1));
    history.replaceState(null, "", location.pathname + location.search);
    try { await importText(code); } catch (err) { toast(err.message, 7000); }
  }
  if (typeof CompressionStream === "undefined") toast("This browser is too old for share codes. Please update it.", 8000);
}
init();
