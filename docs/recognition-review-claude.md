# Picture-event recognition — independent review (Claude)

Date: 2026-11-01. Scope: read-only review of production code and the local debug history in `data/debug/`. No recognition logic, preset, data, env or service was changed. OBS, Decisions and Twitch were not started. Offline reproduction used mock judgements against the real `EventWatcher` in a private scratch directory. This report quotes no model free text, no secret and no image.

## Summary

The pipeline produced 0 candidates during the KSP rehearsal. The model-quality problem is real but secondary. The main cause is the state machine itself:

1. Every Decisions timeout resets the watcher and disarms every armed event. 139 of 148 armed-track losses in the log came from timeouts, not from non-gameplay scenes.
2. Persistent mode asks the model "is the state present now", while every KSP preset describes a transition. A real transition cannot pass two consecutive reviews, and a state that persists passes for the wrong reason.
3. The screen gate looks at one frame per second, so 5 Hz evidence that no screen frame shows is never reviewed. A screen timeout also resets the watcher, and the buffered frames are discarded.

Visual correctness of the model is **not** established by the 4 positive reviews. For the launch, the frames are expired. For the parachute, the local frames show the positive arrived about 20 s after deployment, while the deployment itself was judged "no".

## Evidence base

| Source | Content |
|---|---|
| `data/debug/index.json` | 517 requests (screen ok 304 / timeout 51; review ok 120 / timeout 42), 1178 decisions |
| `data/debug/frames/*.png` | 1797 frames kept, 742 expired. Oldest kept frame 03:13:39.901 UTC; requests span 03:11:08–03:19:41 |
| Runtime state | `.env` has `OBS_FRAME_WATCHER="false"`. The watcher only starts when it is `'true'` (`server/index.js:51`). Recognition is off now |

Latency: screen p50 363 ms / p90 799.9 ms; review p50 529 ms / p90 800.3 ms. The p90 values sit at the 800 ms deadline (`server/judgements.js:9`), so the deadline, not the model, sets the tail.

Decision reasons (all 1178): `verified_negative` 545, `review_unsure` 147, `non_gameplay_screen` 103, gate `positive_screen_threshold` 95, `discard epoch_changed` 76, gate `negative_baseline_or_rearm` 67, `screen_unavailable` 51, `non_gameplay_review` 43, `review_not_required` 39, `verified_positive` 4, `capture_gap` 3, `continuity_unverified` 3, candidate 0.

## Findings (most severe first)

Labels: **Code** = verified from source and reproduced offline. **Incident** = inferred from the debug log and local frames.

### F1. A timeout resets the watcher and disarms all events (Code, critical)

- `server/event-watcher.js:119`: a screen with `!screen.valid` (timeout) calls `reset('screen_unavailable')`.
- `server/event-watcher.js:154`: a review timeout returns the unknown fallback (scene `unknown`, `server/judgements.js:20`), so it resets with `non_gameplay_review`.
- `server/event-watcher.js:63`: `reset()` sets `armed=false` on every track and clears the frame buffer.
- Log: armed tracks cleared by `screen_unavailable` 87, by review timeouts 52, by real `non_gameplay_screen` 9.
- Repro A: armed persistent event + one review timeout → `armedAfter=false`, reason `non_gameplay_review`.

A timeout means "no evidence". It does not mean the scene changed. With a 14% screen and 26% review timeout rate, a baseline rarely survives long enough to be used.

### F2. Review timeouts are logged as `non_gameplay_review` (Code, high)

42 of the 43 `non_gameplay_review` resets were timeouts. One was a gameplay scene below the 0.85 scene threshold. The reset reason hides the main failure mode from the debug page and from any metric. `continuity_unverified` (3) is the only honest second branch.

### F3. Persistent mode contradicts the transition presets (Code + Incident, critical)

- `presets/ksp.json`: launch, landing, eva, flag and parachute are `persistent`, but each description requires a transition (before/after frames, "absent-to-deployed"). Explosion is `instant`. The generic preset (`presets/generic.json`) has the same pattern.
- `server/judgements.js:278` tells the model, for persistent events, to judge whether the state is present in the latest frame and not when it began. Line 279 then requires a before/after sequence for transitions. The two instructions conflict.
- `server/event-watcher.js:175`: a persistent candidate needs `armed && yes >= 2`. Two consecutive reviews are about 0.6–3.8 s apart (window gap p50 607 ms, p90 3825 ms). A launch or deployment visible in one 0.8 s window can produce at most one transition-yes.
- Repro B: transition visible in one review window → 1 positive, 0 candidates.
- Incident: parachute positive `cb9a10f5` (03:19:14, 0.88) arrived when local frames show the chute open since about 03:18:55. That is a "state present" answer to a transition definition: a semantic false positive.
- `test/adaptive-event-watcher.test.js:59-80` mocks constant `yes` for consecutive reviews, so the suite cannot see this conflict.

### F4. The launch baseline was disarmed by one timeout and stayed disarmed through all three launch positives (Incident, high)

1. 03:11:42.462 — review `37e11530`: ksp-launch `no_count` 2 → armed.
2. 03:11:43.254 — screen `64e10171`: launch yes 0.77 passes the 0.6 gate.
3. Review `950f3b53` (frames 03:11:42.4–43.2, the window most likely to hold liftoff) timed out at 799 ms → reset `non_gameplay_review` at 03:11:44.054 → disarmed.
4. Afterwards, screens reported launch yes 0.86–1.0. The negative-baseline gate (`server/event-watcher.js:129-131`) needs a confident "no", so it did not fire while the craft was airborne. ksp-launch stayed disarmed from 03:11:44.054 until 03:16:50.159, when review `30d0b546` armed it again (26 armed records exist in the whole log). The last launch positive was at 03:12:03.019, so all three positives fell inside the disarmed period.
5. Later reviews alternated `review_unsure` (raw yes below 0.85) with review timeouts (`82e72135`, `7220e54c`, `9aa94d4c`, `fdb88d9c`) and screen timeouts (`9254f25e`, `7db54e50`, `0c3294b4`, `a28e098c`).
6. Positives `f3af5a45` (0.88), `8856a334` (0.85) and `720e27fe` (0.86) each had `yes_count` 1 and `armed=false`. They could not produce a candidate, and the preset says an already-airborne craft does not establish launch.

The launch frames (03:11–03:12) are expired. Whether the model saw liftoff is **unverified**.

### F5. Single-frame 1 Hz gate misses 5 Hz evidence (Code + Incident, high)

- `server/event-watcher.js:101-105`: screens run at most once per second on the latest frame. The review window is frozen at screen time (the 0.8 s before it).
- `server/event-watcher.js:122` gates on one frame. A short event that ends before the next screen frame never reaches review.
- Repro C: instant event at 3200–3800 ms, screens at 3000/4000 ms → 0 candidates. The same event at 2400–3000 ms overlaps a screen → 1 candidate.
- Incident (explosion): impact is visible in local frames at 03:19:16.903. Screen `ab2c6c8f` (03:19:16.509) timed out → `screen_unavailable` at 03:19:17.309, then `capture_gap` at 03:19:19.239. The blast frames 03:19:16.079–16.903 were captured and stored but never reviewed. Later reviews `7a537d05` and `4f578df5` saw only aftermath and answered "no". `35beae77` timed out.
- Incident (parachute): screens 03:18:51–55 rated parachute yes 0.35–0.48, below the 0.6 gate, so no parachute review ran during deployment.

### F6. Non-reviewed screens zero all counters (Code, medium)

`server/event-watcher.js:138`: a screen that does not need review sets `yes=0` and `no=0` for every track. Two-in-a-row then also requires no quiet screen between the two reviews. Combined with F3, the persistent path is effectively unreachable for short events.

### F7. Thresholds stack on top of human confirmation (Code, medium)

Each review answer needs ≥ 0.85 (`server/judgements.js:255-295`), persistent events need two in a row, and every candidate still needs a human to confirm it (`server/events.js`; `auto_confirm` applies only to the API). Raw review yes answers in the log: launch 3 at ≥ 0.85 and 12 below; parachute 1 and 7; eva 0 and 1. The machine gates remove recall that the human gate exists to protect.

### F8. Scene gate resets on map and low-confidence gameplay (Code + Incident, medium)

`non_gameplay_screen` (103 OK screens) broke down as: map below 0.85 44, map confident 27, editor low 10, unknown low 9, gameplay low 8, menu low 5. 8 were gameplay judged below the 0.85 scene threshold. KSP orbit insertion is usually watched in map view, and the KSP preset has no orbit event. A map view therefore always resets.

### F9. Observability gaps (Code, low)

- The gate uses `some()` (`server/event-watcher.js:122`), so only the first triggering event is logged per screen.
- Reset and discard records cannot be joined. `#current()` (`server/event-watcher.js:73-75`) writes a `discard epoch_changed` record with the caller's `request_id`. The inference paths pass it (`:117`, `:149`, `:152`, `:159`, `:185`, `:188`). The capture path does not, because no model request exists yet (`:221`, `:223`).
- All 76 `discard epoch_changed` records in this log have no `request_id` (03:11:18.179–03:19:38.073). They are therefore capture-path discards: a frame read that was in flight when a reset changed the epoch. This log has 0 discards after an inference finished. These records do not show that any model request was lost.
- The gap is that a capture discard does not name the reset (reason, epoch transition or triggering request) that caused it. The debug page cannot show which timeout or scene change dropped the frame.

### F10. Model visual misses (Incident, medium, model-side)

During parachute deployment (local frames 03:18:49.074 streaming, 53.067 partial, 55.654 full), reviews answered: `ce8e2bfc` (48.47–49.26) no 0.96, `2b61da8a` no 0.64, `6fa19a0a` no 0.2, `25bdd8a0` unsure 0.28. Review `9d01b505` (55.65–56.49) timed out. This is one deployment on one game; it shows the model can miss a large visible change at 640×360, not a measured miss rate.

## What is not established

- Launch visual correctness: frames expired. **Unverified.**
- Landing: the round-2 vessel crashed. A landing may have occurred in round 1, which has no log. **Unconfirmed.**
- Model precision/recall in general: one rehearsal, a handful of events. No labelled set exists.

## Proposed design (simpler, testable)

1. **Treat a timeout as no evidence.** Do not reset, disarm or clear the buffer. Record `screen_timeout` / `review_timeout` as their own reasons.
   - **Safety boundary.** Keeping the buffer and a verified negative baseline across a timeout does not make unverified positive continuity acceptable. A timeout is never a positive answer.
   - For events that stay `persistent` (real states), a timeout must break the positive run: set `yes` to 0, as a non-yes answer does today (`server/event-watcher.js:169`). Two yes answers separated by an unknown interval are not consecutive and must not count as two in a row.
   - The negative baseline must not live forever. Store when it was verified, and drop `armed` once it is older than a fixed maximum age, or after a fixed number of consecutive timeouts. The event then has to re-establish a fresh baseline before a positive run can count. The exact limit is an open tuning value; it must be bounded.
   - `instant` events judged on one complete valid window (item 2) do not have this counting problem. Each candidate rests on one review that saw the before and after frames itself. A timed-out or incomplete window yields no candidate.
2. **Compatibility first: use the existing `mode` enum correctly.** The interface accepts only `mode: persistent | instant` (`server/event-definitions.js:21`, `server/debug-recorder.js:58`, `docs/events.md:24`). In this report, "transition" and "state" name semantics, not new enum values.
   - Map every one-time change to `instant`: KSP launch, landing, eva, flag, parachute (explosion already is), and the generic first-death, ai-victory and ai-boss. The existing instant path already fits a change. The prompt asks whether the event occurred within the ordered window (`server/judgements.js:278`), and the transition rule (`:279`) still requires a visible before/after. One verified yes while not latched gives a candidate (`server/event-watcher.js:175`). The latch is cleared only after two confident "no" reviews (`:163`), and `reset()` does not clear it (`:63`), so a timeout cannot cause a duplicate.
   - Keep `persistent` only for definitions that really mean "this state is visible now". None of the shipped KSP or generic events is such a state.
   - This is a preset data change inside the current schema. It still needs compatibility handling:
     - The definition fingerprint hashes the whole definition (`server/events.js:6`). Pending candidates for a changed event are fenced out after the switch (`:33`). Apply it with no pending candidates.
     - Saved Named Profiles and custom definitions keep their own `mode`. They are not migrated automatically. List them, and let the operator re-apply the preset or edit them.
     - The UI labels `instant` as "Brief flash" (`public/console-events.js:16`). For a launch this label misleads. A copy change ("One-time change") is optional and does not touch the schema.
     - Tests that assume these events are persistent must be updated with the preset.
3. **One verified positive review → one candidate** for `instant` definitions (this is the current instant behaviour). Keep the human confirmation, the 30 s cooldown, one pending candidate per event, the 5 s staleness check (`server/events.js:76,108`) and the session / profile / definition / epoch fencing (`server/events.js:31-36,84-95`). Do not lower `min_confidence`.
4. **Keep the frozen anchor and widen coverage around it.** Replacing the frozen window with a rolling window is not enough. The screen takes up to 800 ms, so a rolling window taken at review time can lose the trigger frame and the "before" state. A rolling window also only helps after a screen passes the gate, so it cannot catch an event that no screen frame showed (F5, Repro C offset 800). Options, in order of cost:
   - **4a. Frozen anchor + bounded follow-up (low cost).** Keep the frozen window that ends at the screened frame. When it passes, also review the next adjacent window (overlapping by one frame) once, without re-screening. Cost: at most one extra review per gate pass. Safety: the anchor and its "before" frames stay intact; the follow-up only adds "after" evidence for transitions that complete late.
   - **4b. Adjacent overlapping windows with a bounded budget (medium cost).** After a gate pass, review consecutive windows that overlap by one frame until the answer turns negative or a fixed cap (for example 3 windows) is reached. Cost: up to the cap in reviews per pass, and more 800 ms timeouts to absorb. Safety: the cap bounds spend; a timeout counts as no evidence (item 1) and does not cancel the chain.
   - **4c. Low-rate forced window review (medium–high cost).** Every N seconds (for example 5–10 s) review the latest full window even when no screen passed. This is the only option here that can catch an instant event whose frames no screen saw. Cost: a steady extra review rate (0.1–0.2 per second) whether or not anything happens; coverage is still a sampling of the timeline, not every frame. Safety: forced reviews must use the same thresholds and human confirmation; do not lower `min_confidence` to compensate.
   - **4d. Local motion gate (low model cost, local CPU).** Compute a cheap frame difference on the 5 Hz buffer. A spike above a fixed threshold triggers a window review of the frames around it, independent of the screen answer. Cost: local image work per frame, tuning of the threshold, and extra reviews from camera moves in KSP. Safety: it only adds reviews; it never creates a candidate by itself. It needs a cap per minute so that a busy scene cannot flood Decisions.
   - No option above captures every frame. 4a and 4b improve events that reach the gate; 4c and 4d are the only ones that address events that never reach it. Recommended first step: 4a + 4d with a per-minute review cap, measured offline against the kept frames before any live run.
   - In all options, never drop buffered frames on a timeout.

5. **Explicit reset reasons only for real scene changes** (`non_gameplay_screen`, `non_gameplay_review` with an OK answer, `continuity_unverified`, `capture_gap`, stale).
6. **Keep the negative baseline only for real `persistent` states.** A one-time change mapped to `instant` does not need it, because the review window carries its own "before".
7. **Optional, separate: a versioned schema migration adding `mode: "transition"`.** Only consider it if `instant` proves unable to express a change (for example, a change that needs a longer before/after span than one window). It is not a direct edit. It needs:
   - a definition schema version and a preset `version` bump (`presets/ksp.json:2` is version 1);
   - the validator, debug recorder, prompt, watcher branches, UI labels and docs to accept the new value together;
   - a read path that keeps accepting `persistent | instant`, and a defined migration for stored profiles, custom definitions and pending candidates (fingerprints change);
   - rollback: an older server must reject or ignore `transition` safely, never treat it as `persistent`;
   - its own tests for old data, new data and mixed versions.
8. **Log every gate trigger**, not only the first, and attach the reset `request_id` to discards.
9. **Deadline review**: measure success rate at 800 ms vs. a larger frame budget offline before changing it. With timeouts no longer destructive, a longer deadline is a latency trade-off, not a correctness fix.

## Regression tests to add

- Armed state event + screen timeout → still armed; reason `screen_timeout`.
- Armed state event + review timeout → still armed; reason `review_timeout`, not `non_gameplay_review`.
- Persistent event: yes, timeout, yes → positive run broken; no candidate.
- Persistent event: baseline older than the maximum age (or past the timeout limit) → disarmed; needs a fresh baseline.
- `instant` event: timed-out or incomplete window → no candidate.
- Real non-gameplay OK review → reset with `non_gameplay_review`.
- Change event defined as `instant`, visible in one window only → exactly one candidate.
- Same `instant` event, state still visible in later windows → no second candidate until two confident "no" reviews clear the latch.
- `instant` latch survives a screen or review timeout.
- Preset mode switch with a pending candidate → candidate fenced, no crash; saved profiles keep their own mode until re-applied.
- State already present across the whole window → mock answers "no" for the change (answer driven by the frames, not constant `yes`) → no candidate.
- Instant event between two screen frames (Repro C, offset 800) → caught by the chosen option 4c or 4d; with 4a/4b alone it stays a known miss, and the test must state that.
- Gate pass with a screen latency near 800 ms → the reviewed window still contains the screened anchor frame and its preceding frames.
- Follow-up / forced / motion reviews → capped per minute; a timeout inside a chain does not cancel the chain.
- Screen timeout while blast frames are buffered → buffer kept and reviewed next.
- Two events trigger the same screen → both gate reasons logged.
- Capture discard after a reset → record names the reset reason or epoch transition that caused it.
- Cooldown, pending-per-event, 5 s staleness and fencing behaviour unchanged.

## Offline reproduction

Script (private, not in the repo): mock `judgements`, real `server/event-watcher.js`, adaptive mode at 5 Hz.

| Case | Setup | Result |
|---|---|---|
| A | Armed persistent event, one review timeout | `armedAfter=false`, reason `non_gameplay_review` |
| B | Persistent transition visible in one window | 1 positive, 0 candidates |
| C | Instant event 2400–3000 ms (overlaps screen at 3000) | 1 candidate |
| C | Instant event 3200–3800 ms (between screens 3000/4000) | 0 candidates |
