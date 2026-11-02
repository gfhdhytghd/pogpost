# Manual presentation: frontend

Frontend half of the manual presentation contract (backend: `presentation_mode`, `ready_envelopes`,
`ready_count`, `current.revealed_at`, `/ebs/state.presentation`).

## One stage, four places

`public/overlay-stage.js` draws the whole show: the twine line, the ready row, the opening and the
letter. Every place uses it; only the data source and the controls differ.

| Place | Page | Data | Controls |
| --- | --- | --- | --- |
| OBS browser source | `/overlay` | polls `/api/overlay` every 500 ms | none |
| Console stage preview | `/overlay?operator=1` in a same-origin frame on `/console` | polls `/api/overlay` | Open on ready envelopes, Close note |
| Twitch video overlay | `video_overlay.html` | polls `/ebs/state` → `.presentation`; `sealed-refresh` refreshes at once | none |
| Panel Watch tab | srcdoc frame built from a static template in `panel.js` (loads `overlay.css` + `video_overlay.js`) | public snapshots posted by the panel | none |

## Behaviour

- Declaring a moment moves its envelopes from the line to the ready row (they fly from their pins).
  Nothing opens by itself.
- The hanging line displays up to 12 covers. Spacing compresses when crowded, allowing overlap; very short ropes produce a stack. Stable layer order and small alternating tilts expose the edges. The count tag stays above the envelopes. Covers beyond 12 remain included in the total and `+N more on the line`. Physics and manual opening are unchanged.
- The ready row shows at most 8; `+N more ready` uses `ready_count`, not the array length.
- Opening flies the envelope from the ready row, flips it, cracks the seal, opens the flap and unfolds
  the letter (600/280/110/230/230/360/320 ms, 2130 ms in total).
- In manual mode the letter stays until `current` disappears; then it falls off the bottom (900 ms).
  A switch to another note uses a short fade; the automatic deadline keeps the old fade.
- A viewer who arrives later than the opening (`serverNow − revealed_at`, compressed below 35 %) sees
  the letter at once, without the flight.
- Polls and push refreshes can overlap. A snapshot whose `serverNow` is older than the last applied one
  is dropped, so an old response cannot reopen a closed letter.

## Security boundaries

- Covers and the ready row never carry a body; the body appears only on the real `current` letter.
- The operator frame only asks: it posts `{type:"sealed-overlay-open", id}` or
  `{type:"sealed-overlay-close"}` to `location.origin`. The console acts only when
  `event.origin === location.origin` and `event.source === stage iframe.contentWindow`, then calls the
  existing `reveal` / `skip` operator actions with its cookie, and posts back `sealed-overlay-refresh`.
  The frame accepts that only from `window.parent` on the same origin.
- Controls render only with `?operator=1` inside a parent frame. OBS, the video overlay and the Watch
  frame have no buttons.
- Twitch's CDN only lets the supervisor frame extension pages (`frame-ancestors`), so the panel cannot
  frame `video_overlay.html` by URL. The Watch view is a `srcdoc` frame from a fixed template with
  `data-embedded="true"`; relative URLs resolve against the panel, and no user text enters it. It
  inherits the panel's policy; nothing in the Twitch policy changes.
- In the srcdoc frame `location.origin` is `"null"`, so it checks and targets
  `new URL(document.baseURI).origin` and accepts only `{type:"sealed-presentation", presentation}`
  from `window.parent`. The panel accepts only `event.source === watchFrame.contentWindow` with
  `event.origin === location.origin`. The frame makes no requests, runs no Twitch helper and holds no
  token. The panel creates it on first use of the tab and polls every 1 s while the tab is open
  (7 s otherwise).
- The stage markup lives once in `overlay-stage.js`; `overlay.html` and `video_overlay.html` have empty
  bodies.

## Console

- New Stage card with the 16:9 preview.
- Sealed queue: in manual mode only ready notes (`ready_envelopes` or `queue`) have Open this note;
  the rest say Waiting for its moment.
- Skip note reads Close note in manual mode and is disabled with nothing open.
- An API trigger with `auto_confirm` reads "API confirms the moment" in manual mode, because it only
  readies envelopes.

## Stage layout (rope ends)

- `config.reveal.rope = {left:{x,y}, right:{x,y}}`, fractions of the stage. The rope is a quadratic
  Bézier from left to right with a sag; pins and the tally use the same curve as the SVG path.
- Console Stage: Edit layout → handles on both ends in the operator preview (drag, or arrow keys:
  1 %, Shift 5 %). Dragging is a local preview. Save sends `stage_layout_set` with the layout; Reset
  previews the default and its Save sends `layout: null`; Cancel sends nothing.
- The client clamps to the server rules: 0..1 on both axes, `right.x − left.x ≥ 0.1`, three decimals.
  A saved end is never moved; near the bottom the picture can crop the rope.
- On a short rope the tally shrinks to fit and covers can drop to none; the tally keeps the full count.
- Messages (same origin; the console checks `event.source === stage iframe.contentWindow`, the frame
  checks `event.source === window.parent`):
  - console → frame `{type:"sealed-layout-edit", on:true, layout}` start or replace the preview;
    `{type:"sealed-layout-edit", on:false, layout|null}` end it (`layout` = what was just saved, shown
    until a snapshot carries it).
  - frame → console `{type:"sealed-layout-change", layout}` after each drag or key step; the console
    validates the shape before it keeps it as the draft.

## Tests

`test/presentation-browser.mjs` runs the console, OBS overlay and two panel viewers against the real
local app and an in-memory engine in manual mode. `test/stage-layout-browser.mjs` covers rope editing,
save, reload, cancel, reset, read-only viewers and the geometry at 1920×1080, 1280×720 and 640×360.
