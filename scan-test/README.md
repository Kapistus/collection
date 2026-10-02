# Card Scanner Test

A standalone test page for scanning Magic cards with a phone camera or webcam. It is separate from Binder Share and saves nothing.

## How it works

1. The page looks for the card in every camera frame (about 5 times a second) and draws a white outline around it, so you can hold the card anywhere and at any distance. A dashed outline means no card is found yet. If the card is too small in the picture to read, it says **Move the card closer**.
   - Finding the card: the picture is shrunk to 320 px wide, edges are found, and the rectangle with a card's proportions whose four sides are covered by straight, consistent edges wins. It works for a card held roughly upright (up to about 5° tilt).
   - A black-bordered card on a dark table may be outlined at its inner frame instead of its outer edge.
2. When the card has been found and still for about half a second, the page cuts out two areas and reads them with [Tesseract.js](https://github.com/naptha/tesseract.js), which runs in the browser:
   - the **name** bar,
   - the **bottom-left corner**: collector number, set code and language (printed on cards since about 2014).
3. It identifies the card on Scryfall:
   - set code and number read → the exact printing (checked against the name);
   - otherwise the name (fuzzy, so misread letters are fine), narrowed down by whatever set code or number was read;
   - if several printings remain, you pick one from pictures (green = matches what was read).
4. **What was read** shows the cut-out areas and the raw text, to see why a scan failed.
5. The log counts automatic matches, chosen printings and failures, and can be copied as text (`1 Sol Ring (DSC) 94`).

**Test with a photo** reads a photo instead. The card is found in the photo the same way; a photo cropped to just the card is read as the whole card.

## Notes

- The camera only works over HTTPS (GitHub Pages) or on localhost.
- The text reader loads about 9 MB the first time; the browser keeps the language data afterwards.
- **Flashlight** appears only when the browser can control it (usually Android Chrome).
- Foil can't be seen reliably in a photo.

## Deploying

Put the `scan-test` folder in the Binder Share repository, next to `index.html`, and open `https://<user>.github.io/<repo>/scan-test/`.

## Third-party code (in `vendor/tesseract/`)

- tesseract.js 7.0.0 and tesseract.js-core 6.1.2, Apache License 2.0 (licenses included).
- English language data (`eng.traineddata`, 4.0.0_best_int, uncompressed) from the Tesseract OCR project via `@tesseract.js-data/eng`, Apache License 2.0.

Card data and images from [Scryfall](https://scryfall.com); not affiliated with or endorsed by Scryfall. Unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards.
