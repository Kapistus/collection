# Binder Share

View, filter and share Magic: The Gathering collections from ManaBox CSV exports. It's a static site: no accounts, no server, and nothing is uploaded. Collections and lists stay in the browser, and sharing happens through images or links.

## Using it

- **Import:** drop a ManaBox CSV export on the page, or use **Import → Choose file**.
- **Browse:** search, sort, and filter by set, keyword, type, color identity, rarity, foil and binder. Click a card for details.
- **Set aside** cards into lists, like Cardmarket want lists. This never changes the collection.
  - **Add:** use **+** on a card, right-click, or long-press on touch.
  - **Add several:** Ctrl/Shift-click to select cards, then press **A**.
  - **Edit a list:** open it from the dropdown at the top. Use **+**/**−** or **Del**, or right-click.
- **Share** makes an image of what's shown (card pictures, or a text list for more than 150 entries) with a QR code in the corner that carries the list.
  - **Copy image** puts it on the clipboard for pasting into a chat. **Download PNG** saves it. **Copy link** gives a link with the list inside it.
- **Receive** by dropping or pasting (Ctrl+V) the share image on the page, choosing it with **Import**, or opening the link.

A share image still imports after chat apps shrink it and convert it to JPEG. In testing, a full 731-entry collection decoded exactly from a 745 px wide JPEG.

## What the share code contains

Title, set code, collector number, quantity and finish. Nothing else, so no prices paid, condition, language or binders. Card details and current prices are fetched from Scryfall when viewing.

- One QR code holds about 2,600 characters, roughly 800 entries. Bigger lists are split into several QR codes in the same image, and the site reads them all.
- **Format:** `MTG1:` + base64url(deflate-raw(text)). The text is `title` on the first line, then `set:cn[*qty][!f|!e],cn…;set:…` on the second line.

## Deploying on GitHub Pages

1. Put these files in the repository root, or in `/docs`:
   `index.html`, `style.css`, `app.js`, `vendor/`, `.nojekyll`
2. In **Settings → Pages**, choose **Deploy from a branch**, then pick the branch and folder.
3. Open `https://<user>.github.io/<repo>/`.

There's no build step. To test locally, run `python3 -m http.server` in this folder and open `http://localhost:8000`. It has to be served over http, not opened as a file, because the QR reader loads a `.wasm` file.

## Scryfall usage

- Card data comes from `POST /cards/collection` in batches of up to 75, with 100 ms between requests.
- Data is cached in the browser for 24 hours; Scryfall updates prices daily.
- Images load from Scryfall's image servers.

## Third-party code (in `vendor/`)

- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4, MIT license. Writes QR codes.
- [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) 3.1.4, MIT license. Reads QR codes. The license is in `vendor/LICENSE-zxing-wasm`.

## Notices

Unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC. Card data and images from Scryfall; not affiliated with or endorsed by Scryfall.
