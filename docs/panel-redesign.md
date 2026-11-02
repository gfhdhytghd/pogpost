# Viewer panel redesign

The viewer writing panel (`public/panel.html`) now has its own visual identity and its own stylesheet, `public/panel.css`. It no longer loads `styles.css`, so the console, overlay and other surfaces are unaffected.

## Direction: airmail stationery

A sealed note is a letter posted for later. The panel borrows the vocabulary of airmail:

- **The letter.** The text field sits on a paper sheet inside a red-and-blue airmail stripe. This is the one bold element; everything else stays quiet.
- **Ink and paper.** Navy ink on warm paper over a pale airmail-mist background. Dark mode is a night desk: deep navy, soft paper, brighter red and blue stripes.
- **Rubber stamps.** States are stamps: the `TEST MODE — no real charge` mark, and `Sealed`, `In review`, `Rejected`, `Opened` and `Expired` in Your notes.
- **Postmark receipt.** After sealing, the receipt shows a postmark ring: blue when sealed, amber when held for review, red when rejected.
- **Wax seal.** The send button is wax red with a seal glyph.

| Token | Light | Dark |
|---|---|---|
| Mist (page) | `#e6eaf2` | `#10142a` |
| Paper | `#fdfcf8` | `#1b2140` |
| Ink | `#1c2238` | `#eceef7` |
| Airmail red | `#b02e38` | `#ff8d92` |
| Airmail blue | `#2a4599` | `#a3b8ff` |
| Wax | `#a3242f` | `#c23a46` |

Type: Fraunces for the letter, headings and the send button. Instrument Sans for the controls. Both are existing local fonts, so no new font files were added.

## Layout

- **320 px Twitch panel.** The letter field appears directly under a one-line lede and the tabs; there is no hero. Then come envelope, moment, optional conditions (collapsed), postage, identity and the seal button. Envelopes are a fixed two-column grid, and each category name stays on one line.
- **720 px and wider.** The letter sits on the left (sticky) and the routing column on the right.
- **Themes.** The panel follows `prefers-color-scheme`, `data-theme` and the Twitch context theme through the existing theme toggle in `common.js`.
- **Keyboard.** Arrow, Home and End keys move between the two tabs. Envelope buttons keep focus across polling re-renders. Focus rings use airmail blue.

## Behaviour kept

- The form IDs and accessible names used by the API and the regression tests are unchanged.
- The note is limited to 140 characters; the counter turns amber from 120.
- All existing controls remain:
  - envelope (category) choice;
  - moment choice;
  - special condition and the condition matcher;
  - free notes, test points and test Bits, all labelled TEST MODE;
  - the Show my Twitch name and Share identity options.
- Sealed, held and rejected receipts work as before, as do the error status and the opened-note toast.
- Twitch authorization goes through `common.js` unchanged. No public demo identity was added.
- Two small behaviour fixes:
  - A blank note is stopped locally.
  - Changing the envelope starts a new request id.
- Your notes shows the note's words only after the streamer has opened it. Only then does the server include them.

## Assets

- **New:** `public/panel.css`.
- **Not new:** fonts and the seal glyph. The fonts already existed, and the seal glyph is inline SVG.
- **Packaging:** root added `panel.css` to the `tools/package-extension.mjs` allow-list and to the package tests.

## Verification

All runs used the local offline demo application, the local Twitch mock harness and simulated currency. No Twitch upload, broadcast, real Bits or provider API was used.

- `node test/panel-redesign-browser.mjs`: 31 checks. It covers:
  - sealing over the real local HTTP and EBS routes, with the words removed from the page and fields afterwards;
  - the receipt, the Sealed stamp, the opened note with its now-public words, and the opened-note toast;
  - held and rejected notes, a service error and a blank note;
  - keyboard tabs and envelopes;
  - no horizontal overflow and whole category names at 320 px (light and dark) and 1280 px (light and dark);
  - no external requests.
- Screenshots: `shots/panel-redesign-{320-light,320-dark,1280-light,1280-dark,receipt,notes-320}.png`.
- `npm run test:browser` and `npm run test:material3-browser` still pass with the new panel, including the panel contrast checks at 318 px in both themes.

This redesign does **not** show that the blank Twitch Hosted Test iframe is fixed. That issue was not reproduced or investigated here.

## Delivery verification

Root independently ran `npm test` (385/385) and `node test/panel-redesign-browser.mjs` (31/31). The final extension archive includes 14 files, including `panel.css` and the existing local fonts. `sha256sum -c dist/extension.zip.sha256` passed. The package still injects the synchronous Twitch helper before the modules.

The in-memory, offline preview is running at `http://127.0.0.1:8790/panel.html?demo=1`. It uses the local mock Twitch harness, simulated currency and KSP event definitions; it does not read `.env`, connect providers or persist production notes. Chrome was asked to open this preview. The persistent service was refreshed while detection was off so its static file inventory includes the new stylesheet. Detection remains off.

`dist/extension.zip` is staged locally only. It has not been uploaded to Twitch in this redesign task. The existing Hosted Test iframe and its blank-loading fault remain separate acceptance work.

## Hosted Test delivery update — 2026-11-02

The earlier staged-only statement is historical. The redesign and current-profile moment filtering were uploaded to Hosted Test. The current 15-file archive and live loading limitation are recorded in [hosted-test.md](hosted-test.md#2026-11-02-current-profile-moment-scope-deployment). The real Chrome popup loaded the new archive's form, but a public relay HTTP 502 prevented final live data verification. Offline verification does not establish real Twitch note submission.

## Identity permission prompt repair

`Show my Twitch name` controls attribution on the individual note, not revocation of Twitch identity access. The shared `shareIdentity()` helper now skips `requestIdShare()` when Twitch's documented `viewer.isLinked` or `viewer.id` indicates identity is already shared. Unlinked viewers still receive the identity prompt. The local harness models this state. The panel browser suite now checks both the first request and repeated toggling after linking (33 checks); all 389 unit tests pass.

Reference: https://dev.twitch.tv/docs/extensions/reference/#helper-viewer
