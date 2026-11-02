# Sealed Notes

Private notes, opened at the right moment on stream. A standalone Hosted Test prototype with simulated payments.

## Run locally

Requires Node.js 24 or newer (tested with Node.js 26), npm, and Linux `flock` for durable Twitch credential rotation.

```sh
npm ci
npm run demo -- --port=8790
```

Open <http://127.0.0.1:8790>. The demo uses an in-memory store, fake extension identities and deterministic simulated judgements. It never reads `.env` and never connects to Twitch or OpenAI. Open the viewer panel, operator console and OBS overlay from the local hub. The demo script seals sample notes and declares moments; you can also compose notes yourself. Port 8788 currently belongs to the persistent application service; do not start a second demo on that port.

```sh
npm test
npm run test:browser
npm run test:events-browser
```

Browser checks require Chromium (`/usr/bin/chromium`, or `CHROMIUM_PATH`). They use local HTTP and mocked extension lifecycle events. Screenshots are saved under `shots/`.

The latest `npm test` run passed all 406 tests. This establishes the covered local behavior; it does not establish public HTTPS or Twitch acceptance.

## Runtime

`npm start` runs the persistent server on loopback port 8788. Data is saved atomically in `data/notes.json` with mode 0600. Keep that directory private: it contains sealed note bodies. Never serve it through a reverse proxy. `.env` must have mode 0600 and is ignored by Git.

Shipped configuration defaults are `DECISIONS_LIVE=false`, `TWITCH_CONNECT=false` and `PAYMENTS_LIVE=false`. This workstation's application service enables real Decisions; picture recognition is currently stopped. An explicitly started OBS session uses `tools/start-obs-live.mjs`;  [the live verification record](docs/decisions-live.md) separates real requests from mocked tests. Without Decisions, moderation falls back to a human hold. The demo labels its simulated judgements. `PAYMENTS_LIVE=true` is refused at startup for this regular broadcaster channel.

Live Decisions requests use `gpt-6-luna`. Enable `DECISIONS_LIVE=true` or the explicit `--decisions-live` process flag only for an intentional maintainer-run session. The process flag avoids editing credential files and is rejected in demo mode. No live probes run during installation, demo or tests. See [the Decisions API guide](https://developers.openai.com/api/docs/guides/decisions) for the underlying request shape. Independent bounded questions cover moderation, category and moment fit in one request.

## Interface

The operator console and configuration use Material Design 3. The OBS and viewer reveal stages use Claude's physical-envelope design: a twine line, wooden pegs, sealed covers and a paper opening animation. The viewer composer has a separate airmail stationery design by Claude: letter paper, a navy/red postal edge, a wax-seal button and stamped receipts. Both support narrow panels and light/dark themes. The theme button cycles automatic, light and dark. Automatic follows Twitch theme when supplied, otherwise the device preference. Local choices stay on the current origin. Broadcast overlays keep a fixed light palette and a transparent canvas. The operator event panel also offers [game preset switching](docs/game-presets.md), with KSP and general-game collections. Use **New profile** to build a named local draft, then **Save profile** and explicitly **Apply profile** to use it. [Saved profiles](docs/event-profiles.md) persist across restarts. See [the redesign verification](docs/material-3-redesign.md).

The operator desk places Stage at the upper left. Its right column starts with Event suggestions, followed by Declare moment and event/profile management. Quick controls and the remaining panels sit below; narrow screens stack the areas. See [the workspace layout](docs/console-layout.md).

The Quick controls panel groups picture detection, Debug recording, observation reset and a shortcut to game profiles. Its **Start detection / Stop detection** button controls picture recognition without restarting the service. Stopping closes capture, cancels in-flight picture requests and clears pending suggestions; it preserves cooldowns, notes and Debug history. **Reset observations** only clears evidence. To boot configured but stopped, use `tools/start-obs-live.mjs --standby --source="<OBS source>" --port=8788`; the source and credentials stay private and `.env` is unchanged. This button does not start or stop a Twitch broadcast. See the [quick controls reference](docs/operator-controls.md).

## Surfaces

| Route | Purpose | Access |
| --- | --- | --- |
| `/panel.html` | Compose and seal a private note | Extension JWT |
| `/video_overlay.html` | Counter and latency-delayed private toast | Extension JWT |
| `/config.html` | Categories, moderation, moments and prices | Broadcaster JWT |
| `/console` | Review, declare moments, reveal and wrap up | Direct loopback + operator cookie |
| `/overlay` | Canonical OBS reveal, transparent 1920×1080 | Direct loopback |
| `/archive` | Opened notes | Public read-only |
| `/setup` | Save new extension credentials privately | Direct loopback + operator cookie |

The operator cookie is HttpOnly and SameSite Strict. Mutations require a same-origin custom header. A forwarded request cannot reach the console, OBS overlay, demo authentication or operator API. Public requests use explicit routes and sanitized projections. Sealed bodies never appear in viewer receipts, counts or archive responses.

## Test mode

Every price includes `TEST MODE — no real charge`. Viewers receive a simulated wallet per stream. Moderation runs before charging. Paid notes are guaranteed when their moment happens, even when their count exceeds the normal selection limit. Unselected free notes remain sealed until a later occurrence or wrap-up.

Use **Wrap up** before stopping a stream. `stream.offline` does not reveal notes. Long-lived notes remain sealed across sessions. Never start a broadcast through this project.

## Hosted Test and deployment

The new extension **Sealed Notes 0.1.0** is registered and in **Hosted Test**. Its Panel and Video Fullscreen files are uploaded, identity sharing is enabled, and its EBS allowlist is `https://notes.wilflin.me`. It has not been submitted for review or released. See [the registration record](docs/hosted-test.md).

The application and NPC systemd services are active. The application uses persistent storage on loopback port 8788. A new independent NPS client, ID 6, reaches it through `127.0.0.1:18788` on the relay; the relay's `/api/archive` check returned HTTP 200. The existing listener on port 18787 remains in place.

Authorized sudo and issuance of a certificate covering `notes.wilflin.me` succeeded. Normal TLS verification and public archive access now pass. The public/local doctor checks and the relay helper's verification of public/private access boundaries pass. The doctor now reports `ready=true`; numeric extension IDs and broadcaster OAuth are configured. See [deployment readiness](docs/deployment-readiness.md). No broadcast was started.

An earlier deployment returned `ok` but later showed the ACME-only configuration and a state-fingerprint mismatch. Its cause remains unconfirmed. The repaired helper now verifies fingerprints after writing, reloading and saving state; the recovery and final verification succeeded.

The private `/setup` page starts broadcaster Device Code authorization explicitly. The activation code stays in memory and a masked field; an explicit Copy button supports activation on Twitch. Only `wilf_lin` is accepted. Access/refresh tokens and the verified owner/channel IDs are saved atomically after authorization, with all runtime live flags left off. Real OAuth consent completed for `wilf_lin` with exactly `moderator:read:followers` and `user:read:chat`. The temporary authorization server on port 8789 was stopped, and the persistent service was restarted to load the saved credentials. See [authorization evidence](docs/oauth-evidence.md).

## Optional runtime features

- `TWITCH_SIGNALS=true` with `TWITCH_CONNECT=true` enables verified-live duration milestones, bounded Clip polling and chat spikes. Enable Clip/chat detection and set thresholds in the broadcaster config. Timers use Helix `started_at`, not the application uptime. Clip polling is best effort with a 100-item query limit.
- `OBS_FRAME_WATCHER=true` with live Decisions and an explicit `OBS_SOURCE_NAME` runs the generic definition-driven picture watcher. Persistent events use two negative/two positive observations; instant events use one positive window. AI candidates require human confirmation.
- `EVENTS_PRESET_FILE=presets/ksp.json` imports six KSP event definitions atomically; `presets/generic.json` contains the original death/victory/boss events. Events are persisted in `config.events` and capped at twelve. See [generic events and private trigger API](docs/events.md) and [KSP rehearsal](docs/ksp-live-test.md). Real recognition accuracy remains unverified.
- `POST /api/events/trigger` uses a separate `EVENTS_API_TOKEN` and direct loopback access. It shares the AI candidate queue/cooldown and defaults to human confirmation. An event must explicitly set `auto_confirm:true` for API automatic occurrence. Operator-cookie CRUD actions return structured definitions; this refactor changes no frontend UI.
- `SPEECH_WATCHER=true` reads fresh local JSONL transcripts from the private `data/transcripts` directory. It does not capture a microphone or perform speech recognition. Two different agreeing transcript chunks create a prompt. See [optional feature setup](docs/optional-features.md).
- `ASTRA_CONDITIONS=true` enables bounded free-text condition matching through the Codex CLI's ChatGPT login, with `gpt-6-astra`, `ultrafast`, and `low` reasoning. The child receives no API key. Matching only changes the form; it never seals or charges. Failure returns the viewer to the list.

All optional features remain disabled in the saved local configuration. Live Decisions, OBS and optional-signal behavior have not been probed.

## Delivery tools

```sh
npm run doctor -- --local
npm run deploy:prepare -- --origin https://notes.wilflin.me --relay-port 18788
npm run bundle
npm run video:demo
```

The source archive is `dist/source.tar.gz` with a SHA-256 file. The captioned [local demo video](artifacts/sealed-notes-local-demo.mp4) is 104 seconds. It is labelled LOCAL DEMO and is separate from the required future Twitch-running recording.

See [docs/provenance.md](docs/provenance.md) for copied modules and test boundaries. See [progress.md](progress.md) for implementation and acceptance status.

Demo picture checks default to 5 Hz local capture at 640×360 and one direct five-image Decisions review per second (`OBS_REVIEW_MODE=window`). Built-in game events need one matching review followed by broadcaster confirmation. Set `OBS_REVIEW_MODE=screened` to restore cheaper single-image triage and on-demand review. Configure `OBS_FRAME_WIDTH`, `OBS_FRAME_HEIGHT` and `OBS_REVIEW_CONFIDENCE` for private runtime settings. See [picture behavior and limitations](docs/events.md#picture-observation-behavior) and the [demo checklist](docs/demo-recognition-fix.md).

Recognition debug is available at [`/debug`](http://127.0.0.1:8788/debug). Enable its recording switch before a new rehearsal to retain private images, screen/review associations, model choices/confidences, and reset/gate reasons. It never starts capture itself; earlier game images cannot be recovered. See [debug mode and retention](docs/debug-mode.md).

## Shared manual envelope stage

On this workstation, the broadcaster uses manual presentation: **Declare** prepares all matching approved envelopes, **Open** reveals one selected envelope, and **Close note** drops it off-screen. Waiting does not open the next envelope. Use the interactive stage in `/console`; OBS keeps the existing `http://127.0.0.1:8788/overlay` source. Viewers can use the **Watch** tab in the Twitch panel or the extension video overlay. They receive the same public state but have no Open/Close controls.

The rope and attached envelopes use a gravity, mass, constraint and damping simulation. Moving an endpoint or removing an envelope sends a disturbance through the rope; the motion settles instead of looping forever. Reduced-motion mode shows a static equilibrium.

Use **Stage → Edit layout** to drag either rope endpoint. **Save layout** applies the positions to OBS and viewers. **Cancel** discards the preview; **Reset to default** previews the default positions for saving. Arrow keys move a focused endpoint by 1%, or 5% with Shift.

The letter body is withheld until Open. Display names remain subject to each author's name-display choice. [State, privacy and operator action contract](docs/obs-envelope-api.md).

```sh
npm run test:overlay-browser
node test/presentation-browser.mjs
```

