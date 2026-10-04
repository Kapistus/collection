# Card Scanner Test

A standalone test page for scanning Magic cards with a phone camera or webcam. It is separate from Binder Share and saves nothing.

## How it works

1. The page looks for the card in every camera frame (about 5 times a second) and draws a white outline around it, so you can hold the card anywhere and at any distance. A dashed outline means no card is found yet. If the card is too small in the picture to read, it says **Move the card closer**.
   - Finding the card: the picture is shrunk to 320 px wide, edges are found, and the rectangle with a card's proportions whose four sides are covered by straight, consistent edges wins. It works for a card held roughly upright (up to about 5° tilt).
   - A black-bordered card on a dark background has no visible outer edge, so the coloured frame inside the border is found instead. When just outside the found rectangle is darker and more even than just inside it, the page treats it as the frame and adds the border (about 4.5% at the sides, 3% at the top and 8% at the bottom). If a read fails or only finds the name, the other interpretation is tried as well; **What was read** shows which one was used.
2. **Mode** (remembered) decides which frame is read once the card has been found and still for about half a second:
   - **1: first still frame** reads that frame right away. Fastest.
   - **2: sharpest of 6 frames** looks at about 6 frames over 0.7 s and reads the sharpest (measured on the name and set areas). Helps when autofocus is still settling. The log has a Mode column and keeps separate statistics for each mode, so they can be compared.
   - **3: video, photo after 2 misses** reads the video frame; if that doesn't identify the card, it reads a second frame; if that misses too, it takes a real photo with the camera (much higher resolution and the phone's still-photo processing, typically 0.5–1.5 s more) and reads that. The result shows the photo's size, how long it took and whether it was used.
   - **4: photo only** reads every card from a real photo: slowest, sharpest.
   Photos need a browser that can take them from a web page (mostly Chrome on Android); otherwise the page says so and reads the video frame.

   Then the page looks at two generous areas (the dashed boxes), finds the text lines inside them (rows with many light/dark changes), and reads each line as a tight strip with [Tesseract.js](https://github.com/naptha/tesseract.js), which runs in the browser:
   - the **name** area: the lines are tried from the top until one reads as a name,
   - the **set · number** area (full card width): first the whole area at once, picking the collector number, set code and language out of the text wherever they are (artist and copyright are ignored, and the copyright year isn't taken for a number); then line by line if needed. A set code + number pair that exists in the card index wins, combining everything read. Printed on cards since about 2014.
   Before reading, each strip is cleaned up by comparing every pixel with its own surroundings, so glare, shadows, dim light and colour casts don't wash the letters out; if that reads poorly, the strip is tried again with a plain contrast stretch.
   The areas are big enough to contain the text whether the outline is on the card's outer edge or on its coloured frame. Mana symbols and the set symbol are pictures, not text, so they aren't used.
3. It identifies the card in the card index on the device (no Scryfall lookups while scanning):
   - set code and number read → the exact printing (checked against the name; a rarity letter misread as a digit is allowed for);
   - otherwise the closest real card name (misread letters are fine), narrowed down by whatever set code or number was read;
   - if several printings remain, or the name was read only roughly, you pick or confirm from pictures (green = matches what was read);
   - a set code the index doesn't know (a set newer than the index) is mentioned, and the printing isn't guessed.
4. **What was read** shows the cut-out areas and the raw text, to see why a scan failed.
5. The log counts automatic matches, chosen printings and failures, and can be copied as text (`1 Sol Ring (DSC) 94`).

**While you choose a printing**, automatic scanning pauses, so the list doesn't change under you. Choosing a printing or pressing **Skip** continues; **Capture now** also ends the choice.

**Sound and vibration:** two short rising tones when a card is identified (not when you have to choose the printing), played like any media file through the phone's *media* volume; **Vibrate** adds a short vibration (Android). Both are remembered. **Test sound** plays it now and reports what happened, and the diagnostics line shows the result of the last attempt ("played", or why the browser blocked it). Browsers only allow sound after a tap on the page; Chrome can also mute a site (site settings → Sound).

**Camera:** the page remembers the camera you used last and starts with it next time (matched by its id, or by its name if the browser has changed the id). If it's no longer available, the default back camera is used.

## Notes

- The camera only works over HTTPS (GitHub Pages) or on localhost.
- The text reader loads about 9 MB the first time; the browser keeps the language data afterwards.
- **Flashlight, focus and zoom** controls appear under the buttons. They work only where the browser and camera allow it: mostly Chrome on Android, and some webcams in desktop Chrome. iPhone Safari and Firefox don't offer them. Only the controls the camera allows are shown; the note next to **Camera details** lists what isn't available. **Camera details** shows (and copies) exactly what the camera and browser report, for troubleshooting. On phones with several back cameras, try each one in the camera list: often only the main camera has a flashlight and adjustable focus. The zoom slider is logarithmic (fine steps at low zoom); **−** and **+** change the zoom by about 5 %. The zoom is remembered per camera. Box calibration records the zoom: box mode is used only at that zoom, so set it back or recalibrate after zooming.
- **Copy diagnostics** copies the version, status and diagnostics line as text, for reporting problems.
  - **Focus:** untick **Auto focus** and drag the slider; the value is the focus distance (about 10–15 cm for a card held close).
- Foil can't be seen reliably by the camera.

## Box mode

For scanning into a box (for example a 3D-printed box the cards slide into) with the phone fixed above it.

1. Fix the phone so the empty box is in the middle of the picture.
2. Tap **Calibrate box**. The page takes a picture of the empty box and learns its colour and where it is (shown as a thin dotted outline). The calibration is remembered; tap **Recalibrate box** if the phone or the box moves, and **Box mode off** to go back to hand-held scanning.
3. Slide cards in. Calibration keeps a small picture of the empty box floor (the light area in the middle; walls in shade are left out). A card is found by its dark border: the pixels that are much darker than the empty floor was at that spot. This works whatever colour the floor is, as long as it's clearly lighter than a card border (white paper works well), and it isn't thrown off by the camera changing exposure or white balance. Straight lines are fitted to the card's four sides, so a card lying a little crooked is found too, and its picture is turned straight before reading. Capture starts about 0.3 s after a new card stops moving (hand-held: about 0.6–0.8 s). Cards without a dark border (white-bordered cards) can't be found this way; use **Capture now** for those.
4. When the stack reaches the edge of the picture, the page says so: empty the box.

The box area may be much wider than the card; the card is the block that clearly differs from the box colour. When no card is found, the diagnostics line says why (nothing different from the box colour, a block that isn't card-shaped, or a card that partly looks like the box).

**Show what box mode sees** (next to the calibration buttons) shows the box-mode detection under the buttons: the camera picture in grey, red where it's much darker than the empty floor was (the card's border and dark parts), the search area in blue and the card found in green, with the reason when no card is found.

**When box mode scans:** it watches the box area as a whole. Something moves in the box (a card sliding in), the picture is still again, and it isn't the empty box → scan. Finding the card's outline is only used to place the read areas; if the outline isn't found, the last card's position (or the middle of the box) is used, so a card is never left waiting because its outline wasn't found. A card that stays put isn't scanned again ("same card as the last scan"); brightness and focus changes don't count as movement, and for 0.7 s after each scan the picture is ignored. Recalibrate after updating: the calibration now also keeps the look of the empty box, so an empty box is never scanned.

**Hand-held:** a card is scanned once; it's scanned again only after it was gone from the picture for a moment, something clearly moved through the outline, or the still card's art differs from the one scanned last.

**Photos in box mode:** phones usually take photos in a different shape from the video (for example 4:3 photos, 16:9 video), so the photo shows more around the video picture. The card outline found in the video is moved into the photo and checked against it (with and without the zoom, and small shifts); the result says "photo matched to the video". Only if that check fails is the card searched for again in the photo.

A light, matte floor works best (white paper is fine); a black floor won't work, since the card's border is what's found.

## Card index (on the device)

All lookups run on the phone from a compact list of every printing. The scanner makes no Scryfall lookups; without the index it can't identify cards (it says so).

- **Built on GitHub:** `.github/workflows/build-card-index.yml` runs `tools/build_card_index.py` every day (and on demand: Actions tab → *Build card index* → *Run workflow*), so new sets appear within a day. It downloads Scryfall's *Default Cards* bulk file and writes `data/cards.txt.gz` (set, collector number, language, finishes, name and Scryfall id of every paper printing) and `data/version.json`, and commits them only when the cards changed. The workflow needs *Read and write permissions* (Settings → Actions → General → Workflow permissions).
- **Updating by hand:** on GitHub, Actions tab → *Build card index* → *Run workflow* builds a new index right away. On the scanner page, **Check for card index update** asks the site for the newest index at once (the page also checks every time it's opened); **Download again** re-downloads it even if it's current.
- **Kept on the device:** the page checks `data/version.json` at start and downloads the index only when it's new, then keeps it in the browser's IndexedDB. The diagnostics line shows the index state and date.
- **Lookup order:** set code + number → name (closest real card name, allowing misread letters, narrowed by set code or number). Typing a name (suggestions and search) also uses the index.
- Card pictures load straight from Scryfall's image server using the card's id (that's the only thing loaded from Scryfall while scanning).
- To build the index on your own computer instead: `pip install ijson`, then `python3 tools/build_card_index.py` (writes `data/`).

## Version

The version is shown in small text at the top right. When you change `scan.js`, bump it in three places: `VERSION` in `scan.js`, and the `app-version` meta tag and `scan.js?v=` in `index.html`. If the tag turns red and says *reload*, the browser is mixing old and new files: reload, clearing the cache (Ctrl+F5, or a new incognito tab on a phone).

## Deploying

Put the `scan-test` folder in the Binder Share repository, next to `index.html`, and open `https://<user>.github.io/<repo>/scan-test/`.

## Third-party code (in `vendor/tesseract/`)

- tesseract.js 7.0.0 and tesseract.js-core 6.1.2, Apache License 2.0 (licenses included).
- English language data (`eng.traineddata`, 4.0.0_best_int, uncompressed) from the Tesseract OCR project via `@tesseract.js-data/eng`, Apache License 2.0.

Card data and images from [Scryfall](https://scryfall.com); not affiliated with or endorsed by Scryfall. Unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards.
