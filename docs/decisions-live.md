# Real Decisions API connection — 2026-11-01

The existing `gpt-6-luna` adapter is now enabled in the persistent local application. Its shipped defaults and provider-free demo remain opt-in/offline. The previously authorized existing key was reused in memory; no key was created, copied or rewritten during this checkpoint.

## Real verification

| Check | Result | Boundary |
| --- | --- | --- |
| Direct `POST https://api.openai.com/v1/decisions` | HTTP 200, `gpt-6-luna`, choice `launch`, confidence 1, 1002 ms cold request | Synthetic text, not a game screenshot |
| Actual application adapter, isolated MemoryStore | Warmup succeeds in 449.3 ms; synthetic advice note is sealed in 173 ms, moderation source `decisions` at 172 ms, category confidence 0.99 | Real provider and production engine path; no persistent note or wallet created |
| Persistent service after activation | `enabled:true`, `status:ready`, `simulated:false`; actual warmup succeeds in 300.2 ms | Real service and real API; no synthetic note submitted to durable application state |
| Client deadlines | Submission 1500 ms and picture window 800 ms retained | Client cutoffs, not provider latency guarantees |

[Machine-readable sanitized evidence](decisions-live-evidence.json) includes only public model identifiers, fixed synthetic decisions, bounded health/latency metrics and backend integration statuses. It contains no API key, bearer token or real note body.

At the API-only checkpoint, Twitch, picture/sound perception and condition matching were disabled. The subsequent OBS checkpoint below supersedes the picture/sound status.

## Configuration

`server/index.js --decisions-live` overrides `DECISIONS_LIVE` in memory after loading the private file. The actual `.env` remains mode 0600 and its live flag stays false. No OBS/Twitch/payment flag is changed by this override.

Installed non-secret systemd drop-in:

```ini
# ~/.config/systemd/user/sealed-notes.service.d/20-decisions-live.conf
[Service]
ExecStart=
ExecStart=/usr/bin/node /home/wilf/data/Hackathon/sealed-notes/server/index.js --port=8788 --decisions-live
```

The service was reloaded and restarted. The current process already owns port 8788; do not start a second persistent instance against the same store. To return this workstation to the file defaults, remove only this drop-in, run `systemctl --user daemon-reload`, and restart `sealed-notes.service`.

The private operator state now exposes the adapter's sanitized health: enabled/simulated status, deadlines, concurrency, warmup and rolling metrics. Credentials remain absent from these diagnostics, and the existing cookie/loopback boundary protects them. Public archive and viewer projections do not gain this diagnostic object.

## Documentation and tests

- [Official Decisions guide](https://developers.openai.com/api/docs/guides/decisions)
- [Official create-decision reference](https://developers.openai.com/api/reference/resources/decisions/methods/create)
- `test/live-decisions-cli.test.js` uses mocked transport to verify demo/live separation and the private diagnostic projection.
- Automated test commands never require a live request. The real checks above were explicit one-off actions for the user's integration request.
- The operator's manual-moment grouping also completed: [profile and moment-group notes](event-profiles.md).

This is real API connectivity and a real synthetic-note application check. At that checkpoint, OBS capture, KSP event accuracy, real Twitch PubSub delivery and broadcast acceptance were separate, unverified checks.

Final automated verification: `npm test` passes 321/321, including two new mocked live-flag/diagnostics checks. Chrome on the persistent service shows **Note checks · Ready**, with the other integrations Off. [Actual service screenshot](../shots/decisions-live-connections.png). The operator page was opened in a fresh tab so existing draft edits were preserved.


## Live OBS checkpoint — 2026-11-01 local time

The operator enabled OBS WebSocket. Its existing authenticated server is reused over literal loopback only. The requested `视频采集(PipeWire)` name was absent; the sole PipeWire input is actually `屏幕采集(PipeWire)`, which is the configured source. OBS streaming/recording and source settings were not changed.

- Standalone production watcher: five captures succeeded, zero capture failures. Two real Decisions image-window calls completed in 571 ms and 771 ms, under the unchanged 800 ms deadline. Both normalized results were `scene:unknown`, `continuity:unknown`, and all events `unsure`; zero candidates were created. This establishes capture and provider transport, not KSP recognition accuracy or event triggering.
- Persistent application checkpoint: nine captures, zero failures; four Decisions samples with zero provider fallbacks, p50 625.6 ms and p95 721.5 ms. The six current definitions are the KSP events. The legacy `perception.profile:generic` field is a startup fallback selector, not the active definitions or saved-profile identity.
- Chrome shows `Picture & sound: watching` and `Note checks: Ready`. [Actual running console](../shots/obs-live-console.png).
- No OBS frames were written to disk. Images are held in bounded memory and sent to OpenAI while this explicitly enabled service runs. The service checks every two seconds; AI candidates still require operator confirmation. Twitch and payments remain disabled.

`tools/start-obs-live.mjs` is an explicit workstation launcher. It requires `--source=NAME`, reads the existing 0600 `.env`, and reads the existing OBS WebSocket configuration in memory. It requires an enabled, authenticated OBS server. Neither private file is rewritten. Source selection and the service command contain no secrets.

```sh
node tools/start-obs-live.mjs '--source=屏幕采集(PipeWire)' --port=8788
```

The running service uses a later non-secret drop-in:

```ini
# ~/.config/systemd/user/sealed-notes.service.d/30-obs-live.conf
[Service]
ExecStart=
ExecStart=/usr/bin/node /home/wilf/data/Hackathon/sealed-notes/tools/start-obs-live.mjs --port=8788 "--source=屏幕采集(PipeWire)"
```

Remove only `30-obs-live.conf`, reload user systemd, and restart this service to return to API-only operation under the earlier Decisions drop-in. Do not launch a second instance against the same persistent store.

Private operator diagnostics now include bounded capture and watcher health. `test/obs-live-runtime.test.js` verifies credential reuse, unchanged files, unrelated flags, source requirements, authenticated-server prerequisites and `.env` permissions using temporary synthetic fixtures. `npm test`: **322/322 passed**, with no live provider calls in the test suite. [Sanitized OBS evidence](obs-live-evidence.json).


## Adaptive capture checkpoint — supersedes the fixed-window runtime above

The enabled service now defaults to 5 Hz capture at 640×360. At most once per second, it screens only the latest image; plausible event confidence at least 0.60 triggers a separate review of the five nearby frames frozen before screening. Initial/reset negative baselines and rearm also use full reviews so single-image answers never advance event evidence. Review thresholds (default0.85), two-negative/two-positive persistent latches, instant windows, shared cooldowns, and human confirmation remain in force. See [configuration and limitations](events.md#picture-observation-behavior).

The unchanged `30-obs-live.conf` launcher picks up these code defaults without changing `.env` or OBS settings. Private diagnostics show dimensions,200ms capture interval, strategy`single_then_window`,1000ms screening interval, five review frames and gate0.6. At the recorded real checkpoint,41 OBS captures succeeded with zero failures; six screens started and five completed without provider fallback, p50395.2ms and p95588.6ms. No review was requested by that scene, so real positive escalation/game accuracy remains unverified; mocked tests cover both stages. No frames were saved. [Sanitized running-service evidence](adaptive-live-evidence.json). [Actual Chrome console](../shots/adaptive-live-console.png).

`npm test`:347/347 passed. `npm run test:browser`:72 checks. `npm run test:events-browser`:91 checks. `npm run test:ksp-browser`:19 checks. All automated tests mock providers; the real checkpoint above is separately authorized runtime observation.

## Current picture deadline

After the 2026-11-01 demo rehearsal, the authorized picture deadline changed from 800 ms to 2,000 ms. The older measurements above used 800 ms and remain historical evidence. Submissions retain 1,500 ms; speech retains its earlier 800 ms cap. The picture watcher still allows one cycle at a time and skips checks while busy. The new timeout rate has not been measured live. Recognition remains stopped until explicitly started.
