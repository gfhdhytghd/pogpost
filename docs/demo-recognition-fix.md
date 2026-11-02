# Recognition changes for the demo

The demo favors a useful broadcaster suggestion over proving an exact event onset. The broadcaster still decides whether the event happened.

- Default `OBS_REVIEW_MODE=window`: capture 5 Hz at 640×360; review the latest five images at most once per second. Skip the latest-image screening gate.
- KSP and general-game presets use `instant`. One valid positive review is sufficient for a candidate. Observable states accepted by the descriptions do not require a before/after transition inside an 800 ms window.
- Keep the 0.85 event confidence threshold, 2,000 ms request deadline, human confirmation, per-event cooldown and absence-based rearm.
- A missing/unknown review supplies no evidence. A single failure breaks streak counters but retains captures for the next attempt. Three consecutive failures clear evidence. Real scene changes and capture/session/profile fences still reset immediately.
- `OBS_REVIEW_MODE=screened` preserves the previous lower-input strategy. Window mode sends more images during quiet play: up to 3,600 five-image requests per hour before skipped cycles. No new price estimate is asserted here.

## Demo operation

1. Open the operator console at `http://127.0.0.1:8788/console`.
2. Apply the built-in KSP profile. Saved custom profiles retain their own settings; reapplying a saved old profile can restore its old criteria.
3. Seal an envelope for an event before playing. A moment with no matching sealed note cannot reveal an envelope. The local simulated demo on port 8790 is separate from the persistent service on 8788.
4. When live recognition is explicitly started, use the existing `tools/start-obs-live.mjs` launcher with the actual source `屏幕采集(PipeWire)`. This launcher reads existing private credentials and supplies OBS settings in memory. Do not start a second process on occupied port 8788.
5. Play the event and keep visible cues on screen briefly. In **Event suggestions**, select **Confirm moment** for a correct candidate, or dismiss an incorrect one.
6. If recognition misses, use **Make it a moment** to declare the matching event manually. Keep `/overlay` in the OBS browser source. Inspect `/debug` after the demo if necessary.

Recognition remains off after this repair. The next explicit live recognition start loads the new code; no restart or real Decisions probe was performed during the repair. Debug collection remains configured as before.

## Verification

`npm test`: 371 tests passed. This includes a complete local HTTP path from synthetic capture through one positive review, candidate creation, broadcaster confirmation and sealed-envelope reveal. Additional regressions cover an event visible before the latest frame, unavailable-review retry, three-failure reset, request frequency, frozen frames and profile fencing.

Actual KSP recognition accuracy remains unverified after this change. The existing rehearsal images and Debug history were preserved. The active old canonical KSP definitions were replaced through the authenticated operator profile action; sealed notes, occurrences, session and saved profiles were checked unchanged. No `.env` values were edited. No Twitch/OBS/provider test ran.

Claude independently checked the simplified watcher using mock judgements. Its stored-preset concern was resolved by applying the new built-in KSP profile. Its source-configuration concern is covered by the existing explicit OBS launcher. A candidate remains latched until two clear reviewed absences; manually reset observation evidence between staged takes when necessary. A reset does not bypass cooldown.

## Changed files

- `server/event-watcher.js`, `server/visual-config.js`, `server/index.js`: direct-window runtime and bounded retry.
- `server/judgements.js`: distinguish one-window matching from a required onset transition.
- `presets/ksp.json`, `presets/generic.json`: practical instant-event presets.
- `server/ksp-perception.js`: preserve old adapter behavior for historical regression traces.
- `public/console-events.js`, `public/console.html`: accurate detection labels and baseline help, implemented by Claude.
- `test/adaptive-event-watcher.test.js`, `test/demo-window-application.test.js`, `test/visual-config.test.js`, `test/event-presets.test.js`, `test/event-watcher.test.js`, `test/ksp-judgements.test.js`, `test/event-profile-fence.test.js`, `test/debug-pipeline.test.js`, `test/events-browser.mjs`: regressions and explicit legacy-mode fixtures.
- `.env.example`, `README.md`, `docs/events.md`, `docs/game-presets.md`, `docs/ksp-live-test.md`, this report: configuration and demo operation.

No new API/action was introduced. Existing `events_profile_activate` with `{profile_kind:"builtin", profile_id:"ksp"}` applies the preset. Existing `confirm_ai` with `{id, approve:true}` confirms a candidate. Both are operator-cookie actions at `POST /api/operator/action`.

Browser verification (Claude, local mocked application only):

| Command | Passed checks |
| --- | ---: |
| `npm run test:events-browser` | 92 |
| `npm run test:material3-browser` | 161 |
| `npm run test:ksp-browser` | 19 |
| `npm run test:moments-browser` | 17 |
| `npm run test:browser` | 72 |

Claude visually inspected `shots/events-editor.png`. The browser runs also regenerated `docs/material3-evidence.json` and `docs/browser-evidence.md`. New custom events retain the existing persistent default; select **One matching window** for a demo event that should propose after one valid review.

## Operator start/stop button

The console now has **Start detection / Stop detection** under **Event suggestions**. Detection starts configured but off in the workstation service (`--standby`). The operator can start, stop and restart it without a service restart. **Reset observations** remains separate. Stopping cancels in-flight picture requests, closes capture and clears pending suggestions while preserving Debug history and cooldowns. It does not start or stop an OBS/Twitch broadcast. Picture inference retains the new 2,000 ms deadline.

Backend verification: `npm test` passed 381 tests, including eight runtime-control checks and provider cancellation isolated from note predictions. All automated start/stop checks use mock sources and mock providers. The actual service was checked as `enabled:false`, `controllable:true`; no live capture was started during implementation.

`npm run test:perception-browser`: 20 checks passed against local mock HTTP, including start/stop payloads, in-flight disabled state, non-optimistic polling, failure handling, missing configuration, independent reset and narrow layout. A separate read-only browser check of the actual service found **Start detection** enabled and the state **Off. No pictures are checked.**; screenshot: `shots/perception-live-off.png`.
