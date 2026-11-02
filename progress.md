# Build progress

## Generic event system (2026-11-01)

- Generalized the KSP implementation into definition-driven `EventWatcher` and named multi-question `Judgements.eventFrames`. KSP and original generic events are JSON presets; compatibility adapters preserve old call shapes.
- `config.events` atomically persists at most 12 normalized definitions alongside synchronized moments. Added operator-cookie CRUD/import actions without changing the console frontend in this refactor.
- Added the separate Bearer-authenticated, direct-loopback `POST /api/events/trigger`. Public origins, forwarded traffic and nonlocal Hosts cannot use it. AI and API share persistent candidates and cooldowns; API automatic confirmation is opt-in per definition, while AI still requires a human.
- Added durable active-session idempotency receipts, bounded ingress/history, definition/session/reset/expiry fences and explicit API provenance. Old queued evidence cannot apply a new definition or open a new session's notes.
- Verified `npm test`: 270/270; `npm run test:events`: 91/91; KSP console browser: 19 checks. Tests use mock providers, synthetic captures and local/temporary stores.
- The refactor did not read or modify real `.env` values, contact Decisions/OBS/Twitch, restart services, change frontend UI or make commits. Real recognition accuracy remains unverified.
- API/actions and fields: `docs/events.md`. KSP preset rehearsal: `docs/ksp-live-test.md`.

## Earlier KSP picture recognition (2026-11-01; generalized above)

- Added the opt-in `OBS_GAME_PROFILE=ksp` profile with six AI moments: launch, destructive explosion, landing, EVA, flag and parachute deployment.
- One named multi-question Decisions request observes up to four time-stamped images. It validates scenes/continuity and independent event answers; unknown, refused, missing or low-confidence answers never become positive events.
- Added real-capture IDs/timestamps, bounded history, absent baselines, event-specific streak rules, latches, cooldowns, stale-result fences and private observation reset.
- Human confirmation remains mandatory. Session/expiry checks occur inside the serialized domain mutation, preventing queued old observations from revealing a new session's notes.
- The console shows observation time and fixed evidence rules without exposing images or provider prose.
- `npm test`: 216/216 pass. Existing browser suite: 72 checks pass. New KSP console suite: 19 checks pass. All KSP/OBS/model tests use synthetic inputs or mocks.
- Real KSP accuracy, physical OBS capture and live API deadline success remain unverified. No provider probe, broadcast or live flag enablement was performed for this change.
- Setup and rehearsal: `docs/ksp-live-test.md`. Safe mocked UI screenshot: `shots/ksp-confirmation.png`.

## Current scope

Build the standalone project specified in `SPEC.md`. New extension registration and scoped relay deployment were explicitly approved. Review/release, unrelated sites or tunnels, and starting a broadcast remain excluded. All UI and repository text are English.

## Implemented local scope

- Standalone ESM Node project and package lock.
- Authorized API key copied into ignored `.env`, mode 0600. No Twitch account or extension credentials copied.
- Copied durable credential, extension auth/name/PubSub, local request, Decisions transport, content filter and rate limit modules.
- Explicit public route set, strict extension origin/JWT checks, broadcaster config authorization, direct-loopback operator cookie and action header.
- Offline demo environment independent from `.env`.
- Decisions multi-question adapter, bounded concurrency/coalescing, hard deadlines and conservative fallback.
- Twitch EventSub and Helix adapters, durable refresh, authenticated moderator commands and explicit lifecycle flags.
- Atomic private JSON store; moderation/category modes; quote, charge and idempotent receipts; simulated wallets and refunds.
- Count, absolute window and after conditions; built-ins, paid guarantees, sequential reveals, prediction overrides, wrap-up and long-lived carry-over.
- Viewer panel and video overlay, broadcaster config, operator console, OBS reveal, per-stream public archive and local demo hub.
- Optional loopback OBS single-source screenshot reader with two-frame confirmation prompts. It never declares a moment automatically.
- One-command offline scripted demo and Hosted Test asset packaging.
- Verified-live duration milestones, bounded Clip polling, configurable chat spikes and offline/reconnect fences.
- Optional fresh private transcript proposals and validated natural-language condition matching through the specified isolated Codex CLI.
- Private loopback credential setup with masked inputs, atomic saves, response redaction and provider flags forced off.
- Offline doctor, staged deployment files, clean-extracted source archive and SHA-256.
- A captioned 104-second LOCAL DEMO video and final live-recording shot list.
- New `Sealed Notes 0.1.0` extension registered on `wilf_lin`, identity sharing enabled, files uploaded, state Hosted Test. See `docs/hosted-test.md`.
- Independent security and integration review with regression fixes for anonymous identity, early body disclosure, cross-session refunds, stale condition references, bounded admission and AI dismissal.

## Evidence

- `npm test`: 270/270 passing in the latest run.
- `npm run test:browser`: 72 checks pass; 24 exact-size screenshots and two alpha proofs are recorded in `docs/browser-evidence.md`.
- `npm run test:auth-browser`: 19 isolated private-authorization UI checks pass, with two terminal-state screenshots containing no activation code. This uses a fake authorization provider; it does not establish real consent.
- Screenshot inspection covers composition and reveal typography, category colors, readable verdict/reliability, config, review, private toast and wrap-up reel.
- PNG alpha checks verify transparent corners for the local OBS and extension overlay pages.
- `npm run ext:zip -- https://notes.wilflin.me`: nine static assets, no credentials; upload MD5 matches the local archive. Assets are in Hosted Test. Application, tunnel, verified public TLS/archive access and denied private routes are separate checks.
- Authorized key equality, `.env` mode 0600 and Git ignore status were verified without printing the key.
- No Decisions or OBS runtime probes were executed. The approved browser-mediated Twitch registration, settings and upload were completed. Explicitly approved real Twitch Device Code consent completed; verified tokens were saved privately.
- The new extension secret was saved through the loopback setup page. Its input cleared immediately, presence/structure and mode 0600 were checked without printing its value.
- Port 8788 now runs the persistent application under systemd. Its NPC service is active. The temporary private authorization server on port 8789 was stopped after consent; its activation code was never printed or written to disk.
- Real OAuth consent completed for `wilf_lin`, with exactly `moderator:read:followers` and `user:read:chat`; the verified owner/broadcaster/user ID is `1594736759`. Access/refresh tokens were saved atomically with `.env` mode 0600. The persistent application was restarted with live-provider flags off.
- SSH as `admin@wilflin.me` and explicitly authorized sudo succeeded. A certificate covering `notes.wilflin.me` was issued successfully.
- Independent NPS client ID 6 was created with a distinct key. The new relay listener is `127.0.0.1:18788`; its `/api/archive` request returned HTTP 200. The existing port-18787 listener remains in place.
- The NPS template binds the broker listener to `127.0.0.1`. The Linux memfd launcher keeps tunnel secrets out of command arguments, environment, logs and named disk configuration. Local synthetic testing and the real tunnel check are separate evidence.
- Normal TLS verification and public `/archive` access now pass. `npm run doctor -- --local --network --origin https://notes.wilflin.me` passes every local/network check. All checks now pass with `ready=true` after OAuth and numeric-ID setup.
- The relay helper's final verification returned `ok`, `system_trust_verified` and `public_and_private_checked`. An earlier successful HTTPS phase was followed by canonical ACME-only configuration and a state-fingerprint mismatch; that earlier cause remains unconfirmed. The repaired helper verifies fingerprints after write/reload/state save. Recovery and final verification succeeded.
- Upstream game-dependent test references are retained separately; see `docs/provenance.md`.

## Runtime boundaries

- Real payment adapters remain mocked and dormant. This regular broadcaster channel cannot accept real charges.
- Clip polling observes at most 100 results per query and is not exhaustive.
- Speech proposals consume local transcripts; a microphone/transcription producer is not bundled or started.
- Live model access, runtime tool-disable enforcement, physical OBS and real end-to-end latency remain unverified.

## External acceptance still pending

- The public TLS/archive and private-route checks pass. Hosted Test iframe/PubSub and real stream acceptance remain separate pending checks.
- OAuth and numeric-ID verification are complete; live EventSub/PubSub and broadcaster acceptance remain unverified.
- Real channel activation and live OBS/iframe/PubSub/latency checks.
- Physical OBS screenshot source and real perception accuracy.
- Maintainer-started live rehearsal and final video.

No extension was submitted for review or released. No broadcast was started. No existing extension was altered. No commits or pushes were made.

PENDING

## Generic event console checkpoint — 2026-11-01

- Right-side Claude implemented event CRUD, preset preview/import, source-labelled candidates and generic observation reset.
- Independent isolated UI run: 42 checks pass over the real local operator/trigger HTTP routes. Provider calls remain mocked.
- Actual Chrome on the persistent console renders all six KSP definitions and their editor. Cancellation leaves definitions unchanged.
- See `docs/chrome-e2e-2026-11-01.md` for the separate real Hosted Test bootstrap and local complete reveal evidence.

## Material 3 interface checkpoint — 2026-11-01

- Right-side Claude rewrote the shared UI across all eight surfaces with a lilac M3 scheme, light/dark themes, sans-serif typography and Material controls.
- Existing functional assertions remain intact: 271 unit/integration tests, plus browser suites of 72, 19, 42 and 19 checks pass.
- Independent M3 verification passes 161 checks with 1,268 core-text contrast samples, no external requests and true overlay transparency. Two contrast defects were corrected.
- Actual Chrome verified the new console/panel and theme control. The in-memory preview runs on loopback port 8790.
- New extension ZIP and source bundle are local artifacts. The Material 3 ZIP is not uploaded; previous Hosted Test assets remain separate. See `docs/material-3-redesign.md`.

## Operator game preset checkpoint — 2026-11-01

- Added a private fixed catalog for KSP and General games, served through `events_presets`; no public filesystem route.
- The Material 3 console previews replacements before applying via existing `events_import`, identifies Custom edits, preserves pasted JSON and requires explicit unsaved-editor discard.
- Verified 277 unit/integration tests, 58 event UI checks, 72 generic browser checks and 161 Material 3 checks. Actual isolated Chrome switched both directions; persistent KSP definitions remained unchanged.
- See `docs/game-presets.md` for fields, screenshots, commands and boundaries. No `.env` edit, live provider call, remote deploy or commit.

## Saved event profile checkpoint — 2026-11-01

- Added private atomic saved snapshots and explicit profile activation with expected revisions. Profile drafts do not change running events.
- Applied identities persist, including same-content profiles and applied labels older than a newly saved revision. Current event edits are marked modified.
- A persisted monotonic context epoch prevents old AI/API/confirmation/auto results from surviving profile or definition A→B→A changes. Cooldowns and retry history remain.
- Verified 319 unit/integration tests, 91 event UI checks, 72 generic browser checks, 19 KSP checks, 19 authorization checks and 161 Material 3 checks.
- Actual Chrome created/saved/applied a profile on an isolated temporary JSON store, then restored it after a full process restart.
- Opened a new Chrome window at the persistent Operator New profile editor. Existing six event definitions remain; all live integrations are Off. No test profile was written there.
- See `docs/event-profiles.md` for contracts, bounds, files, screenshots and verification. No real provider call, `.env` edit, remote deployment or commit.

## Manual moment grouping and real Decisions checkpoint — 2026-11-01

- Make it a moment now separates current running events, general built-in/Twitch moments and a default-collapsed Other & historical group. No moment or history was deleted.
- Verified 17 grouping browser checks, 72 generic browser checks and 161 Material 3 checks; long 80-character names fit at 390 px, history expansion/focus and profile drafts survive polling.
- The user explicitly requested real Decisions integration. Reused the previously authorized key without creating or changing credentials. Direct official API request returned HTTP 200 using gpt-6-luna.
- An isolated production-engine check sealed a synthetic note using real Decisions moderation in about 172 ms; the persistent note store was not used.
- Installed a non-secret systemd startup override with --decisions-live. The .env file remains mode 0600 with its stored live flag false; the process override enables the real adapter.
- Persistent service warmup succeeds (300.2 ms), operator health is ready/simulated:false, and Chrome shows Note checks Ready. Twitch, picture/sound and compiler remain disabled. OBS source name is pending before frame recognition is connected.
- Final npm test: 321/321. New demo/live guard and private diagnostics checks use fake transport. All routine test suites remain provider-free.
- See docs/decisions-live.md and docs/decisions-live-evidence.json for exact evidence boundaries. No API key disclosure, OBS/Twitch connection, broadcast, remote deployment or commit.


## Live OBS connection checkpoint

User enabled the authenticated OBS WebSocket server. The actual sole PipeWire source is `屏幕采集(PipeWire)`. Production source/watcher connected: five successful standalone captures, two real image-window Decisions responses (571/771 ms), all unknown/unsure and zero candidates. Persistent service enabled through the explicit local launcher and non-secret `30-obs-live.conf`; nine successful captures and four provider samples without fallback at the checkpoint. No images saved; no artificial events/notes submitted; Twitch/payments unchanged. Chrome shows watching/Ready. `npm test`: 322/322. KSP event recognition accuracy remains unverified; see docs/decisions-live.md and sanitized docs/obs-live-evidence.json.


## Adaptive 5 Hz capture checkpoint

Completed default640×360/5Hz local capture,1Hz latest-image screening,confidence>=0.60 five-image review with frozen sub-one-second snapshot. Added validated OBS_FRAME_WIDTH/HEIGHT and OBS_REVIEW_CONFIDENCE runtime settings. Initial/rearm negative windows also verify to preserve original evidence rules. Capture continues during both800ms stages; no inference backlog; single-image answers never declare events. Kept legacy differential traces and added adaptive/stage/schema/jitter/config/privacy/fence tests. `npm test`:347/347; browser72,eventUI91,KSP19. Persistent service restarted; real health proves41 captures/no failures and completed real single-image screens. No real escalation in current unknown scene; game accuracy unverified. Docs/events.md records missed-flash and cross-window continuity limits. No `.env` values changed, no git commit.


## Recognition debug mode and workbench

Completed private persistent debug recorder, `/debug` MaterialYou3 workbench (right-sideClaude), capture UUID/time/dimensions, exact single-screen/five-review links, structured raw/model-normalized outputs, usage and fixed timeout/HTTP/malformed/transport outcomes, gate/evidence/reset/discard/candidate reasons. Explicit recording toggle persists across restart; initialdefaultoff; now enabled for next rehearsal while picture recognition remainsOFF. No retrospective game images available. Retention5000frames/512MiBimages/32MiBmetadata with explicitexpiry/drop/errors;700dirs/600files; loopback/cookie/Origin restrictions on allroutes. Fixed atomictempcleanupfaults, boundedCJKmetadatareload, validrefusalclassification, and deterministic old25msconcurrencytest usingvirtualclock. `npm test`:364/364; DebugUI32; main72/auth19/Material3 161. Saved mockgalleryscreenshots and actualemptyreadyservice screenshot. `/debug` opened in existingChrome session, verifiedbywindowtitle. SeparateTwitchwindowfound butbrowserautomationhost anddesktoppreviewunavailable; no accountactions. No `.env` valueschanged, no commits. Earlierrecognition-semanticbugs remain outside thisobservabilitychange.
