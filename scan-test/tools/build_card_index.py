#!/usr/bin/env python3
"""Build the card scanner's local card index from Scryfall's "Default Cards" bulk file.

Output (in --out, default: scan-test/data next to this script's folder):
  cards.txt.gz   sets and printings, one line each (gzip-compressed text)
  version.json   build time, Scryfall's file date and counts; the page checks this to know when to download again

Usage:
  python3 build_card_index.py                       # download from Scryfall (needs internet)
  python3 build_card_index.py --input cards.json --sets-input sets.json   # offline, from saved files

Line formats in cards.txt.gz (fields separated by "|"):
  #sets
  code|name|released (YYYY-MM-DD)
  #cards
  id (32 hex, no dashes)|set|collector number|lang|finishes (n=nonfoil f=foil e=etched)|name|printed name (non-English only)

Digital-only printings (MTG Arena / MTGO) are left out: they can't be scanned.
Requires: Python 3.9+; "ijson" (pip install ijson) is used when available to stream the large file with little memory.
"""
import argparse, datetime as dt, gzip, hashlib, io, json, os, shutil, sys, tempfile, time, urllib.request

API = "https://api.scryfall.com"
HEADERS = {"User-Agent": "BinderShare-CardScanner-Index/1.0", "Accept": "application/json;q=0.9,*/*;q=0.8"}


def fetch(url, dest=None):
    """GET a URL (Scryfall asks for a User-Agent and Accept header). Returns bytes, or saves to dest."""
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=300) as r:
        if dest is None:
            data = r.read()
            return gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data
        with open(dest, "wb") as f:
            shutil.copyfileobj(r, f, 1 << 20)
    time.sleep(0.1)  # Scryfall: 50-100 ms between requests


def download_link(item):
    """The file address in a bulk-data entry: "download_uri", or any other field holding a download address."""
    if not isinstance(item, dict):
        return ""
    if isinstance(item.get("download_uri"), str) and item["download_uri"].startswith("http"):
        return item["download_uri"]
    for k, v in item.items():
        if "download" in k.lower() and isinstance(v, str) and v.startswith("http"):
            return v
    return ""


def bulk_entry(kind="default_cards"):
    """Find the current download for one bulk file in Scryfall's list of bulk files (GET /bulk-data)."""
    raw = fetch(API + "/bulk-data")
    try:
        d = json.loads(raw)
    except ValueError:
        sys.exit(f"Scryfall's bulk-data list isn't JSON. It starts with: {raw[:300]!r}")
    items = d.get("data", []) if isinstance(d, dict) else d
    items = [it for it in (items if isinstance(items, list) else []) if isinstance(it, dict)]
    want = kind.replace("_", " ").lower()
    entry = next((it for it in items if it.get("type") == kind), None) or \
            next((it for it in items if str(it.get("name", "")).lower() == want), None)
    if not entry:
        sys.exit(f"No '{kind}' entry in Scryfall's bulk-data list. Entries: {[(it.get('type'), it.get('name')) for it in items]}")
    link = download_link(entry)
    if not link and isinstance(entry.get("uri"), str):   # the entry's own page may have the address
        try:
            entry = {**entry, **json.loads(fetch(entry["uri"]))}
            link = download_link(entry)
        except Exception as e:
            print(f"Couldn't read {entry['uri']}: {e}", flush=True)
    if not link:
        sys.exit(f"The '{kind}' entry has no download address. Its fields: " +
                 json.dumps({k: (v if len(str(v)) < 120 else str(v)[:120] + "…") for k, v in entry.items()}))
    entry["download_uri"] = link
    return entry


def open_json(path):
    """Open a JSON file that may be gzip-compressed."""
    with open(path, "rb") as f:
        magic = f.read(2)
    return gzip.open(path, "rb") if magic == b"\x1f\x8b" else open(path, "rb")


def iter_cards(path):
    f = open_json(path)
    try:
        import ijson  # streams the array: ~500 MB of JSON without loading it all
        yield from ijson.items(f, "item", use_float=True)
    except ImportError:
        yield from json.load(f)
    finally:
        f.close()


def clean(s):
    return (s or "").replace("|", "/").replace("\n", " ").strip()


def main():
    global API
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"))
    ap.add_argument("--input", help="saved Default Cards JSON (skip the download)")
    ap.add_argument("--sets-input", help="saved /sets JSON (skip the download)")
    ap.add_argument("--api", default=API, help=argparse.SUPPRESS)   # for testing against a local copy
    a = ap.parse_args()
    API = a.api.rstrip("/")
    os.makedirs(a.out, exist_ok=True)

    tmp = None
    if a.input:
        cards_path, source_updated = a.input, "local file"
    else:
        meta = bulk_entry("default_cards")
        source_updated = meta.get("updated_at", "")
        tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
        print(f"Downloading {meta['download_uri']} ({meta.get('size', 0) / 1e6:.0f} MB)…", flush=True)
        fetch(meta["download_uri"], tmp)
        cards_path = tmp
    sets_json = json.load(open_json(a.sets_input)) if a.sets_input else json.loads(fetch(API + "/sets"))

    sets = {}
    for s in sets_json.get("data", []):
        sets[s["code"]] = (clean(s.get("name")), s.get("released_at") or "")

    rows, names, skipped = [], set(), 0
    for c in iter_cards(cards_path):
        if c.get("digital") or c.get("layout") == "art_series":
            skipped += 1
            continue
        fin = "".join(sorted({"nonfoil": "n", "foil": "f", "etched": "e"}.get(x, "") for x in (c.get("finishes") or [])))
        name = clean(c.get("name"))
        printed = ""
        if c.get("lang", "en") != "en":
            printed = clean(c.get("printed_name") or " // ".join(f.get("printed_name", "") for f in c.get("card_faces", []) if f.get("printed_name")))
        rows.append((c["set"], c["collector_number"], c["id"].replace("-", ""), c.get("lang", "en"), fin, name, printed))
        names.add(name)
    rows.sort(key=lambda r: (r[0], len(r[1]), r[1]))

    used_sets = sorted({r[0] for r in rows})
    lines = ["#sets"] + [f"{code}|{sets.get(code, ('', ''))[0]}|{sets.get(code, ('', ''))[1]}" for code in used_sets]
    lines += ["#cards"] + [f"{i}|{s}|{cn}|{lang}|{fin}|{name}|{printed}".rstrip("|") for s, cn, i, lang, fin, name, printed in rows]
    data = gzip.compress(("\n".join(lines) + "\n").encode("utf-8"), compresslevel=9, mtime=0)
    with open(os.path.join(a.out, "cards.txt.gz"), "wb") as f:
        f.write(data)
    version = {"built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "source_updated": source_updated,
               "printings": len(rows), "names": len(names), "sets": len(used_sets), "bytes": len(data), "format": 1,
               "sha": hashlib.sha256(data).hexdigest()[:16]}   # the page re-downloads only when this changes
    with open(os.path.join(a.out, "version.json"), "w") as f:
        json.dump(version, f, indent=1)
    if tmp:
        os.remove(tmp)
    print(f"{len(rows)} printings, {len(names)} names, {len(used_sets)} sets, {len(data) / 1e6:.2f} MB compressed "
          f"({skipped} digital-only skipped) → {a.out}")


if __name__ == "__main__":
    sys.exit(main())
