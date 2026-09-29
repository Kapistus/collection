# Binder Share

View, filter and share Magic: The Gathering collections from ManaBox CSV exports. It's a static site: no accounts, no server, and nothing is uploaded. Collections and lists stay in the browser, and sharing happens through images or links.

## Using it

- **Import:** drop a ManaBox CSV export on the page, or use **Import → Choose file**.
- **Browse:** search, sort, and filter by set, keyword, type, color identity, rarity, foil and binder. Click a card for details.
- **Set aside** cards into lists, like Cardmarket want lists. This never changes the collection.
  - **Add:** use **+** on a card, right-click, or long-press on touch.
  - **Add several:** Ctrl/Shift-click to select cards, then press **A**.
  - **Edit a list:** open it from the dropdown at the top. Use **+**/**−** or **Del**, or right-click.
- **Share** (applies to the cards currently shown) has three modes:
  - **Card sheet:** an image of the cards, or a text list above 150 entries, with the QR code in the corner.
  - **QR code only:** just the QR code with the title and card count. This is the smallest image.
  - **Link / code:** the share link and the raw code, each with its own Copy button.
  - Images can be copied to the clipboard or downloaded as PNG.
  - When the whole link fits in one QR code (up to about 850 entries), the QR code contains the link itself, so scanning it with a phone camera opens the site with the cards.
- **Receive** by dropping or pasting (Ctrl+V) either share image on the page, choosing it with **Import**, opening the link, scanning the QR code with a phone, or pasting the code into **Import**.

**Compare a want list:** copy a want list from Cardmarket, paste it into **Compare**, and pick a collection. The site sorts the cards into *already have*, *partly* and *need to buy*.
- Cards are matched by name, so any printing or finish counts. Double-faced cards match by either face.
- Accepts Cardmarket's list formats: `4 Dark Ritual`, `1x Sol Ring`, a bare `Skullclamp`, and version markers like `Stock Up (V.1)`. It also reads the quantity-on-its-own-line format you get when copying a list from Cardmarket.
- **Copy cards to buy** copies what's still missing, one `quantity name` per line.
- **Show owned in gallery** filters the collection down to the matching cards.
- **Set aside owned…** puts the matching copies into a list, so you know what to pull from your binders.

**Importing** a ManaBox CSV, a shared collection or a shared list, when you already have any collections or lists:
1. **Exactly the same** as one of them, whatever the names: the site asks whether you're sure you want to import it again. **Cancel** is the default.
2. **A changed version** of one of them: the site asks whether to **merge** it into a collection or list (the best match is preselected in a dropdown listing all your collections and lists) or **create a new** one. **Replace selected** is also offered; it's the only option that removes cards, such as ones you've sold.
3. **No cards in common** (no printing and finish in common): **merge** into any collection or list you pick, or **create a new** one.

**When merging**, choose how cards already in the target are handled. A card counts as already there when the same printing and finish is, in any binder, condition or language. For whichever collection or list is selected, the dialog shows how many of the imported cards are already there, and a **Result** line with exactly what the chosen option will add, change or skip, and the card count before and after.
- **Only cards that aren't there yet:** printings already there are skipped and left as they are.
- **New cards and changed quantities:** best for a newer ManaBox export of the same collection. ManaBox rows are matched exactly (card, finish, binder, condition, language and "Added" time): a known row takes the new quantity, any other row is added. If the file's rows don't match the selected collection's, the dialog warns that this mode would add those cards as extra rows.
- **Everything, adding quantities together:** for combining separate piles of cards. Copies are added to a matching entry (same row, else same printing, condition and language, else same printing) instead of creating a second one.

The last mode used is remembered.

Names never matter; the dropdown always offers all your collections and lists. A shared list prefers a matching list and a collection prefers a matching collection. Merging never removes anything.

The site remembers your last choice for cases 2 and 3 separately and offers it as the default, so Enter repeats it. A list shared from a list imports as an editable list, so keeping the latest share image in a chat works as a sync between devices.

**Export** (for the cards currently shown) has four formats:
- **ManaBox CSV:** the same columns as ManaBox's own export.
- **Cardmarket want list:** `1 Card Name` lines, merged by name.
- **Moxfield / Archidekt / Arena text:** `1 Sol Ring (DSC) 94 *F*`.
- **Spreadsheet CSV:** quantity, name, set, number, finish, rarity and price.

Each can be copied or downloaded.

**Backup:** Export → **Download backup** saves all collections, lists and your last want list to a `.json` file. Restore it with **Restore from backup…**, or by dropping the file on the page. You can merge it with what you have, or replace everything.

A share image still imports after chat apps shrink it and convert it to JPEG. In testing, a full 732-entry collection decoded exactly from a 745 px wide JPEG.

## What the share code contains

Title, whether it's a list or a collection, set code, collector number, quantity and finish. Nothing else, so no purchase prices, condition, language or binders. Card details and current prices are fetched from Scryfall when viewing.

- One QR code holds about 2,600 characters, roughly 800 entries. Bigger lists are split into several QR codes in the same image, and the site reads them all.
- **Format:** `MTG1:` + base64url(deflate-raw(text)). The text is `title` on the first line, then `set:cn[*qty][!f|!e],cn…;set:…` on the second line.

## Deploying on GitHub Pages

1. Put these files in the repository root, or in `/docs`:
   `index.html`, `style.css`, `app.js`, `vendor/`, `.nojekyll`
2. In **Settings → Pages**, choose **Deploy from a branch**, then pick the branch and folder.
3. Open `https://<user>.github.io/<repo>/`.

There's no build step. When you change `app.js` or `style.css`, bump the version in three places so browsers don't mix old and new files: `APP_VERSION` in `app.js`, and the `app-version` meta tag and `?v=` values in `index.html`. GitHub Pages lets browsers cache files for 10 minutes. To test locally, run `python3 -m http.server` in this folder and open `http://localhost:8000`. It has to be served over http, not opened as a file, because the QR reader loads a `.wasm` file.

## Scryfall usage

- Card data comes from `POST /cards/collection` in batches of up to 75, with 100 ms between requests.
- Data is cached in the browser for 24 hours; Scryfall updates prices daily.
- **Prices:** Scryfall's EUR price, which is Cardmarket's Trend Price. When a card has no trend, Scryfall falls back to Cardmarket's 1-day average, 7-day average, average or suggested price. Foils use the foil trend. Cards with no EUR price at all show Scryfall's USD price instead, marked with $.
- **Price change:** the status bar shows how much the value of the collection or list has changed since the previous, different prices (for example `+€2.00`), and the card details show each card's previous price. Only cards with a price history and EUR prices are counted.
- The status bar shows the value of the whole collection or list (and of the filtered cards, when a filter is on) and when the prices were fetched. **Refresh** refetches prices older than an hour.
- Images load from Scryfall's image servers.
- **Price when added:** ManaBox's *Purchase price* column, shown in the card details and as *value when added* in the status bar, with the change since then (for example `value when added €2373.16 (+€2.54 since)`). The change only counts cards whose price then and now is in the same currency. ManaBox fills it with the card's price on the day it was added, unless you entered your own.

## Third-party code (in `vendor/`)

- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4, MIT license. Writes QR codes.
- [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) 3.1.4, MIT license. Reads QR codes. The license is in `vendor/LICENSE-zxing-wasm`.

## Notices

Unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC. Card data and images from Scryfall; not affiliated with or endorsed by Scryfall.
