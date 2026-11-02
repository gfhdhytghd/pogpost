# KSP preset and rehearsal

KSP recognition now uses the [generic event system](events.md). The six definitions live in `presets/ksp.json`; no KSP-specific watcher runs in production. The old `KSPWatcher` and `kspFrames` names are compatibility adapters for existing callers/tests. `KSPWatcher` retains the old persistent modes for those callers; the production generic watcher uses the current JSON modes.

| Preset event ID | Label | Evidence |
| --- | --- | --- |
| `ksp-launch` | Launch | Visible liftoff or powered climb close to the launch pad |
| `ksp-explosion` | Destructive explosion | Visible blast with destruction/wreckage, not exhaust or staging |
| `ksp-landing` | Landing | Touchdown or intact craft in clear surface contact |
| `ksp-eva` | Spacewalk / EVA | A separate suited Kerbal outside the craft |
| `ksp-flag` | Flag planting | Visible planting or a recognizable flag standing on terrain |
| `ksp-parachute` | Parachute deployment | Open canopy and suspension lines attached to the craft/Kerbal |

All six use `mode:"instant"`: one matching reviewed window can produce a suggestion without a negative baseline or a second positive. All six default to threshold 0.85, cooldown 30 seconds, and `auto_confirm:false`. Thresholds are uncalibrated routing settings, not measured accuracy. These demo presets accept clear visible states as well as transitions. An already landed craft, existing flag, outside Kerbal or open parachute can create a candidate; the operator confirms whether the event is new. Latching and the 30-second cooldown suppress repeated suggestions. Custom `persistent` definitions retain their two-negative/two-positive semantics. Orbit, docking, fuel depletion and celestial-body identity are outside this preset.

## Deliberate setup

On the machine running the backend, enable OBS WebSocket authentication and select the exact KSP game source. Use the game source only, not the final scene, desktop, chat, webcam or Sealed Notes overlay. Never send private overlays or desktop content as game evidence.

Edit existing `.env` entries privately; do not shell-source the file or copy its contents into logs:

```dotenv
PAYMENTS_LIVE=false
EVENTS_PRESET_FILE=presets/ksp.json
DECISIONS_LIVE=true
OBS_FRAME_WATCHER=true
OBS_WS_URL=ws://127.0.0.1:4455
OBS_SOURCE_NAME=YOUR EXACT KSP GAME SOURCE
OBS_PASSWORD=YOUR EXISTING OBS WEBSOCKET PASSWORD
```

Keep `.env` mode 0600. Preserve all existing credentials. `EVENTS_PRESET_FILE` atomically replaces definitions on each startup; clear this setting after initial import if operator CRUD will own later edits. Legacy `OBS_GAME_PROFILE=ksp` still selects this preset when the watcher is enabled with no definitions and no explicit file, but new setups should use the JSON setting.

Restart only the application deliberately after setup. Do not start a second persistent writer against its data file. `TWITCH_CONNECT=true` is independent and only needed for Twitch integration/PubSub, not local recognition rehearsal. The generic trigger API works without OBS or live Decisions; see [its authentication and confirmation rules](events.md#trigger-api).

## Rehearsal

1. Keep broadcasting stopped. Use recorded KSP footage as a dedicated OBS media source, or play locally.
2. Open `http://127.0.0.1:8788/console` and explicitly apply the current KSP built-in profile. Existing saved profiles retain their saved definitions until edited or replaced.
3. Produce an event and inspect the time-stamped candidate. Verify sealed notes remain private before confirmation.
4. Dismiss one candidate and verify no moment occurs.
5. After rearming/cooldown, confirm a new candidate and verify one occurrence, OBS reveal and public archive entry.
6. Test exhaust versus explosions, staging versus breakup, already-landed craft, existing flags, pauses, map views, loads and craft switches.
7. Reset observations after loading a save or switching craft. Verify source failures, session changes and definition edits invalidate old evidence/candidates.
8. Record false candidates, misses, duplicate candidates, deadline failures and time-to-candidate on independently labeled clips.
9. Only after rehearsal, install/activate Hosted Test and manually start your broadcast. Test panel sealing, human confirmation, OBS reveal, delayed author toast and archive.
10. Press **Wrap up stream** before manually stopping the broadcast.

The demo defaults to 5 Hz local capture at 640×360, directly reviewing the latest five frames once per second (`OBS_REVIEW_MODE=window`). A matching KSP instant event enters the broadcaster confirmation queue after one valid review. Visible demo cues are sufficient; an exact before/after transition inside 800 ms is not required by these presets. `OBS_REVIEW_MODE=screened` restores the earlier cheaper single-image gate. Configure dimensions and the screened gate as described in [picture observation behavior](events.md#picture-observation-behavior). Each request keeps its 2,000 ms deadline. Slow cycles skip without backlog. No live visual accuracy claim follows from mocked tests.

The current console uses the existing candidate confirmation controls. This backend refactor adds structured operator CRUD actions for the separate frontend without changing its UI. AI candidates always require human confirmation; preset `auto_confirm` only permits automatic authenticated API events when explicitly enabled.

## Offline checks

```sh
npm run test:events
npm run test:ksp
npm run test:ksp-browser
```

These commands use synthetic captures, model answers and local HTTP. Existing KSP regression tests and fixed-trace differential tests verify the generalized behavior. The KSP browser screenshot is `shots/ksp-confirmation.png` and contains mock candidates. It is not real KSP recognition evidence.

No labeled real KSP clips are bundled. The workstation OBS connection has a separate [live record](decisions-live.md); KSP recognition accuracy and recall remain unverified. To stop recognition, set `OBS_FRAME_WATCHER=false`; also set `DECISIONS_LIVE=false` to stop all live judgements, then deliberately restart. Always keep `PAYMENTS_LIVE=false`.
