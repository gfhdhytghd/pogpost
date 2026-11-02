# Operator workspace layout

The operator desk uses `public/console-layout.css`, loaded only by `console.html`.

- Desktop: Stage occupies the upper left. The independently scrolling right column contains Event suggestions, Make it a moment (Declare moment), and event/profile management, in that order.
- Below the workspace: Quick controls first, followed by connections, current/review/sealed notes and the other panels.
- Narrow screens: the same areas stack vertically in reading order. Event editors use container queries so they fit the right column regardless of viewport width.
- Stage keeps its 16:9 frame and existing physics, endpoint editing and Open/Close controls.

Existing control IDs and actions are retained. The LAN gateway explicitly serves the operator-only stylesheet; no Twitch extension upload is needed for this operator-only rearrangement.

`node test/console-layout-browser.mjs` passed 44 checks with screenshots at 1440, 1920, 768 and 390 pixels. The related quick-control and perception regressions passed 28 and 20 checks after their old layout assertions were updated. The current column order was also read back from the live Chrome DOM: `ai-section`, `moment-section`, `events-section`; the column starts at scroll position zero and the page has no horizontal overflow.
