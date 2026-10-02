# Card Scanner Test

A standalone test page for scanning Magic cards with a phone camera or webcam. It is separate from Binder Share and saves nothing.

## How it works

1. The page looks for the card in every camera frame (about 5 times a second) and draws a white outline around it, so you can hold the card anywhere and at any distance. A dashed outline means no card is found yet. If the card is too small in the picture to read, it says **Move the card closer**.
   - Finding the card: the picture is shrunk to 320 px wide, edges are found, and the rectangle with a card's proportions whose four sides are covered by straight, consistent edges wins. It works for a card held roughly upright (up to about 5° tilt).
   - A black-bordered card on a dark background has no visible outer edge, so the coloured frame inside the border is found instead. When just outside the found rectangle is darker and more even than just inside it, the page treats it as the frame and adds the border (about 4.5% at the sides, 3% at the top and 8% at the bottom). If a read fails or only finds the name, the other interpretation is tried as well; **What was read** shows which one was used.
2. **Mode** (remembered) decides which frame is read once the card has been found and still for about half a second:
   - **1: first still frame** reads that frame right away. Fastest.
   - **2: sharpest of 6 frames** looks at about 6 frames over 0.7 s and reads the sharpest (measured on the name and set areas). Helps when autofocus is still settling. The log has a Mode column and keeps separate statistics for each mode, so they can be compared.

   Then the page looks at two generous areas (the dashed boxes), finds the text lines inside them (rows with many light/dark changes), and reads each line as a tight strip with [Tesseract.js](https://github.com/naptha/tesseract.js), which runs in the browser:
   - the **name** area: the lines are tried from the top until one reads as a name,
   - the **set · number** area: the bottom-most one or two lines, with the collector number, set code and language (printed on cards since about 2014).
   Before reading, each strip is cleaned up by comparing every pixel with its own surroundings, so glare, shadows, dim light and colour casts don't wash the letters out; if that reads poorly, the strip is tried again with a plain contrast stretch.
   The areas are big enough to contain the text whether the outline is on the card's outer edge or on its coloured frame. Mana symbols and the set symbol are pictures, not text, so they aren't used.
3. It identifies the card on Scryfall:
   - set code and number read → the exact printing (checked against the name);
   - otherwise the name (fuzzy, so misread letters are fine), narrowed down by whatever set code or number was read;
   - if several printings remain, you pick one from pictures (green = matches what was read).
4. **What was read** shows the cut-out areas and the raw text, to see why a scan failed.
5. The log counts automatic matches, chosen printings and failures, and can be copied as text (`1 Sol Ring (DSC) 94`).

**While you choose a printing**, automatic scanning pauses, so the list doesn't change under you. Choosing a printing or pressing **Skip** continues; **Capture now** also ends the choice.

**Sound:** a short blip plays when a card is identified (not when you have to choose the printing). Switch it off with **Sound**; the choice is remembered. Browsers only allow sound after a tap, so it starts working once you've pressed **Start camera**.

**Camera:** the page remembers the camera you used last and starts with it next time (matched by its id, or by its name if the browser has changed the id). If it's no longer available, the default back camera is used.

## Notes

- The camera only works over HTTPS (GitHub Pages) or on localhost.
- The text reader loads about 9 MB the first time; the browser keeps the language data afterwards.
- **Flashlight, focus and zoom** controls appear under the buttons. They work only where the browser and camera allow it: mostly Chrome on Android, and some webcams in desktop Chrome. iPhone Safari and Firefox don't offer them. Only the controls the camera allows are shown; the note next to **Camera details** lists what isn't available. **Camera details** shows (and copies) exactly what the camera and browser report, for troubleshooting. On phones with several back cameras, try each one in the camera list: often only the main camera has a flashlight and adjustable focus.
  - **Focus:** untick **Auto focus** and drag the slider; the value is the focus distance (about 10–15 cm for a card held close).
- Foil can't be seen reliably by the camera.

## Card index (on the device)

Lookups run on the phone from a compact list of every printing; Scryfall is asked only when the list can't answer.

- **Built on GitHub:** `.github/workflows/build-card-index.yml` runs `tools/build_card_index.py` every Monday (and on demand: Actions tab → *Build card index* → *Run workflow*, e.g. after a new set). It downloads Scryfall's *Default Cards* bulk file and writes `data/cards.txt.gz` (set, collector number, language, finishes, name and Scryfall id of every paper printing) and `data/version.json`, and commits them only when the cards changed. The workflow needs *Read and write permissions* (Settings → Actions → General → Workflow permissions).
- **Kept on the device:** the page checks `data/version.json` at start and downloads the index only when it's new, then keeps it in the browser's IndexedDB. The diagnostics line shows the index state and date.
- **Lookup order:** set code + number on the device → name on the device (closest real card name, allowing misread letters, narrowed by set code or number) → Scryfall online. Scryfall is used when the index isn't there yet, when the set code read belongs to a set newer than the index, or when no name is close enough. The result says *found on the device* or *looked up online*, and the log marks online lookups.
- Card images load straight from Scryfall's image server using the card's id.
- To build the index on your own computer instead: `pip install ijson`, then `python3 tools/build_card_index.py` (writes `data/`).

## Version

The version is shown in small text at the top right. When you change `scan.js`, bump it in three places: `VERSION` in `scan.js`, and the `app-version` meta tag and `scan.js?v=` in `index.html`. If the tag turns red and says *reload*, the browser is mixing old and new files: reload, clearing the cache (Ctrl+F5, or a new incognito tab on a phone).

## Deploying

Put the `scan-test` folder in the Binder Share repository, next to `index.html`, and open `https://<user>.github.io/<repo>/scan-test/`.

## Third-party code (in `vendor/tesseract/`)

- tesseract.js 7.0.0 and tesseract.js-core 6.1.2, Apache License 2.0 (licenses included).
- English language data (`eng.traineddata`, 4.0.0_best_int, uncompressed) from the Tesseract OCR project via `@tesseract.js-data/eng`, Apache License 2.0.

Card data and images from [Scryfall](https://scryfall.com); not affiliated with or endorsed by Scryfall. Unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards.
