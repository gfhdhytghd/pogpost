# OBS envelope covers

The local OBS Browser Source uses `http://127.0.0.1:8788/overlay`.
The LAN gateway also serves `/overlay` and its independent `/overlay.css`.
Neither address changes the current game capture source or starts a broadcast.

`GET /api/overlay` remains a private, direct local/LAN route. Its additional fields are:

- `serverNow`: server time in milliseconds, for estimating the remaining `current_until` interval.
- `sealed_envelopes`: the oldest twelve notes whose status is `sealed`, in stable creation order.
- Each cover has exactly `id`, `display_name`, `moment_label`, `condition_label`, `category_id`, and `payment_mode`.
- `display_name` is null unless the author chose to show their name when sending the note.
- `condition_label` combines the stored moment label with an occurrence count, time limit, or preceding moment when applicable.
- Covers never contain note bodies, Twitch numeric/opaque IDs, wallet details, moderation results, or credentials.
- `sealedCount` remains the total count, which can exceed the bounded cover list.
- `current` is still the only presently opened note. Its body can be rendered after the server marks it revealed.

Profile changes do not rewrite existing envelopes. Reconnects and polling do not authorize opening a sealed note. The overlay must use the server's `current` and `current_until`, rather than a client timer deciding which note may open.

Backend validation: `node --test test/envelope-covers.test.js test/lan-webui.test.js` checks consented names, human-readable conditions, bounded metadata, sealed-body privacy, lifecycle removal, and the LAN stylesheet route.

## Manual, shared presentation

The current workstation will use `reveal.mode = "manual"`. Existing stores without a mode retain `auto` for compatibility. Set the mode using authenticated operator action `{ "action": "presentation_set", "mode": "manual" }`; the normal atomic configuration store persists it.

In manual mode:

1. Declaring an event places every eligible, approved note into the ready queue. Manual mode does not use the autoplay AI selection cap. It does not reveal a body.
2. `ready_envelopes` contains up to twelve selected covers; `ready_count` is the complete count. These covers move out of `sealed_envelopes` on the rope.
3. Operator action `reveal` with an eligible `id` opens exactly that note. The server rejects an unready note or a second note while another is open.
4. The opened note stays open until operator action `skip` closes it. Closing does not advance to the next note. Repeated opens of the same current note are idempotent.
5. `current.revealed_at` supplies the authoritative opening timestamp. `current_until` is null in manual mode.

Authenticated viewers get the same public presentation in `GET /ebs/state` under `presentation`. Its pending queue entries contain IDs only; covers never disclose sealed bodies. The existing public endpoint and exact Twitch origin/JWT checks remain in force. Viewers cannot invoke the private operator actions. PubSub broadcasts carry a compact presentation change signature, not bodies; polling remains a fallback.

`node --test test/manual-presentation.test.js` verifies preparation, explicit open/close, waiting beyond the previous timeout, chosen-order opening, persistence, idempotency, public redaction, viewer read-only access, and body-free change notifications.

In manual presentation mode, an automatically confirmed event still only prepares eligible envelopes. It never bypasses the broadcaster's Open/Close controls. Event confirmation and envelope opening are separate decisions.

## Current verification

The workstation is configured in manual mode. The existing OBS source URL is unchanged and its refresh succeeded. The real Twitch Test profile can open Watch and return to the authenticated writing form. Non-empty prepare/open/close synchronization is covered by `node test/presentation-browser.mjs` (43 checks), with three independent surfaces and a private in-memory store. This is separate from public broadcast acceptance, which was not run. See [deployment evidence](hosted-test.md#2026-11-02-shared-manual-presentation-deployment) and [UI details](manual-presentation-ui.md).

## Rope endpoint layout

The broadcaster can save rope endpoints in `config.reveal.rope`:

```json
{"left":{"x":0.0,"y":0.025},"right":{"x":1.0,"y":0.025}}
```

Coordinates are normalized to the stage rectangle, from 0 to 1. The right endpoint must remain at least 0.1 stage width to the right of the left endpoint. Both points require exactly numeric `x` and `y` values. Existing stores receive the default coordinates when they load.

Authenticated operator action `stage_layout_set` accepts `layout` containing both endpoints. `layout:null` resets the default. The action uses the existing operator cookie, same-origin and direct-local/LAN rules. It saves through the normal atomic config store and updates the presentation notification signature. Read-only viewers receive the same coordinates through `presentation.config.reveal.rope`; they cannot save a layout.

`node --test test/stage-layout.test.js test/lan-webui.test.js` covers strict validation, saved reload, reset, unchanged sessions, rejected viewer/forwarded writes and the shared presentation.

### Endpoint editor controls

In the console, choose **Stage → Edit layout**. Drag either circular endpoint, or focus it and press arrow keys (1%; Shift+arrow: 5%). Dragging only changes the operator preview. **Save layout** persists and broadcasts it. **Cancel** returns to the saved layout without a request. **Reset to default** previews the default endpoints; save to apply the reset. Short ropes reduce the visible envelope count and retain the total on the tag. There are no editing controls in OBS or the viewer stage.

The layout browser check (`npm run test:stage-layout-browser`) passed 45 checks, including drag, keys, local-only preview, save, reload, cancel, reset, forged messages, viewer read-only behavior, sloped/short ropes, and responsive geometry. The full unit suite passed 398 tests. The actual local Chrome console also saved a 1% vertical endpoint change and restored the original default layout; the temporary test layout was not left active.

## Rope physics

`public/rope-physics.js` contains a deterministic cable-and-pendulum solver. It uses width-normalized coordinates, fixed 120 Hz Verlet integration, gravity, velocity damping and mass-weighted distance constraints. Envelope loads affect the cable's equilibrium; envelopes swing as damped pendulums driven by their attachment acceleration. Adding/removing loads produces a small impulse. Layout endpoints remain pinned.

The solver caps long-frame catch-up at 100 ms and at twelve substeps, preventing background tabs from accumulating a large simulation backlog. Static settling is available for initial placement, resizing and reduced-motion display. These are tuned visual-simulation parameters, not measured material properties. Physics never selects or opens a note: the server presentation remains authoritative.

`node --test test/rope-physics.test.js` covers gravity, loaded equilibrium, constraints, determinism across render rates, anchor movement, released tension, damping, long gaps, resizing, resolution invariance and invalid inputs.

The renderer check `npm run test:physics-browser` passed 13 checks for multi-node SVG, actual endpoint/load motion, settling and RAF sleep, unchanged snapshots, resizing, reduced motion and sealed-body privacy.

## Overlapping hanging envelopes

The shared renderer displays up to 12 sealed covers without reducing their count to fit the rope width. Crowded covers overlap; a very short rope forms a stack. Later covers draw above earlier covers, with a small alternating tilt. The count tag draws above all covers. This applies to the console, OBS source, Twitch overlay and panel Watch view. Existing endpoint positions remain unchanged.
