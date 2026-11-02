# Configurable events and private trigger API

The picture watcher is definition-driven. KSP is one preset, not a separate runtime detector. Definitions are bounded data, never executable code or model instructions. The persistent application stores normalized definitions under `config.events` in the existing atomic private JSON store, alongside moments. No credentials belong in a preset.

## Definition schema

```json
{
  "id": "example-landing",
  "label": "Landing",
  "description": "A visible descent is followed by stable surface contact. An already landed vehicle does not establish a new landing.",
  "mode": "persistent",
  "min_confidence": 0.85,
  "cooldown_s": 30,
  "auto_confirm": false
}
```

| Field | Validation |
| --- | --- |
| `id` | Required; `^[a-z][a-z0-9-]{0,59}$`; unique in the collection |
| `label` | Required nonempty text, at most 100 Unicode characters |
| `description` | Required nonempty broadcaster-written evidence criteria, at most 300 Unicode characters |
| `mode` | Required: `persistent` or `instant` |
| `min_confidence` | Finite number from 0 to 1; default 0.85 |
| `cooldown_s` | Integer from 1 to 3600; default 30 |
| `auto_confirm` | Boolean; default false |

Unknown fields, duplicate IDs, unsafe text, malformed values and more than 12 definitions are rejected. The event ID is also its moment ID. Defining an event creates/synchronizes an AI moment; conflicting declared/Twitch moments are rejected. The generic preset's `first-death` retains the existing builtin. Deleting a definition keeps its moment for sealed notes, preceding conditions and history; it stops recognition/API triggering for that ID. The total moment limit remains 40.

## Presets and startup

Importable files have exactly this shape:

```json
{"version":1,"events":[]}
```

`presets/ksp.json` contains the six KSP events. `presets/generic.json` contains death, victory and boss-defeated events. `presets/generic-legacy.json` supplies metadata only for deprecated single-frame compatibility APIs and is not an importable event collection.

Set `EVENTS_PRESET_FILE=presets/ksp.json` in the private `.env` to import that JSON at startup. Absolute paths are also accepted. The loader accepts only a regular nonsymlink UTF-8 JSON file up to 64 KiB and validates the complete collection before an atomic replacement. Import replaces definitions and synchronizes moments without deleting note history. When this setting remains configured, each restart reapplies the file; remove the setting after initial import if operator CRUD is intended to be the durable source of truth.

For backward compatibility, an enabled watcher with no definitions and no explicit preset imports `presets/generic.json`, or `presets/ksp.json` when legacy `OBS_GAME_PROFILE=ksp` is selected. An explicitly imported empty collection remains empty.

## Picture observation behavior

With `OBS_FRAME_WATCHER=true`, `DECISIONS_LIVE=true` and a named loopback OBS source, the demo defaults to `OBS_REVIEW_MODE=window`:

1. Capture at 5 Hz (200 ms), retaining the latest five frames. Default resolution is 640×360; `OBS_FRAME_WIDTH` / `OBS_FRAME_HEIGHT` remain configurable.
2. At most once per second, send all five ordered frames directly to Decisions. There is no single-image gate in this mode. The request asks scene, continuity and each configured event independently.
3. A valid matching review proposes an instant event immediately for human confirmation. Built-in KSP and generic presets use instant events with observable demo cues. They do not certify an exact transition timestamp. Stable visible cues can trigger when recognition first starts.
4. Capture continues during inference. The submitted window stays frozen, there is no queued inference backlog, and each request retains the 2,000 ms deadline. Menu/map/editor, changed continuity, stale captures, scene/session/profile changes still discard evidence.
5. An unavailable review supplies no positive evidence and breaks consecutive evidence counters. One unavailable review retains captures for the next attempt. Three consecutive unavailable reviews clear evidence, including any persistent baseline. Debug request outcomes distinguish actual timeouts from scene answers.

The upper rate is 3,600 five-image requests per hour before skips. Image input is higher than a quiet screened session; exact billing depends on provider usage. This is a demo tradeoff for recall, not measured recognition accuracy. A short flash between windows can still be missed; keep important game states visible briefly. Private diagnostics report `strategy:direct_window`, capture settings and request counters.

`OBS_REVIEW_MODE=screened` restores the earlier cost-saving path: one latest-image screen per second, then a frozen five-frame review when a positive exceeds `OBS_REVIEW_CONFIDENCE` (default .60), or a verified negative baseline/rearm is needed. A screen never counts as event evidence. This path can miss a brief signal even when it was captured locally. Direct legacy watcher/KSP compatibility construction retains its historical behavior for regression traces.

Persistent events need two clear negative observations followed by two positive observations. Instant events can propose on one positive window. Both latch until two negative observations rearm the event. A cooldown-suppressed event is consumed instead of surfacing later from the same positive evidence. AI observations always create human-review candidates, including when `auto_confirm=true`; the automatic option applies only to authenticated API triggers. AI never directly declares an occurred moment.

Sampling, image buffers, cache IDs/timestamps, freshness checks and inference admission are bounded. Menu/map/editor transitions, failed/stale captures, gaps over 600 ms in adaptive capture (six seconds in legacy mode), continuity changes, reset, wrap-up, session changes and definition edits discard evidence. Reset/session fencing starts before awaiting a screenshot, so a pre-reset request cannot become fresh post-reset evidence. In-flight model results retain their original definition fingerprint. Candidate acceptance and final confirmation recheck session, policy fingerprint and expiry inside serialized store mutations.

Model/API candidates share one private candidate ledger and per-event cooldown. Cooldown deadlines survive reset, restart, definition edits and delete/re-add. Candidates expire after 30 seconds. Expired, changed-definition and previous-session candidates cannot be confirmed. Images and raw model prose never enter the candidate ledger, viewer responses or public archive.

## Trigger API

`POST /api/events/trigger` accepts direct loopback requests only. Configure a separate random `EVENTS_API_TOKEN` in the ignored `.env`, mode 0600. This work does not generate or change a real token. No token means HTTP 503 `events_api_disabled`.

```http
POST /api/events/trigger HTTP/1.1
Host: 127.0.0.1:8788
Authorization: Bearer <EVENTS_API_TOKEN>
Content-Type: application/json

{"event_id":"example-landing","context":"Observed by the local controller.","idempotency_key":"flight-001-landing-01"}
```

`event_id` is required and follows the definition ID format. `context` is optional text up to 1,200 Unicode characters. `idempotency_key` is required and matches `^[A-Za-z0-9_.:-]{1,128}$`. Unknown fields and query strings are rejected; the body limit is 8 KiB. Do not put the token in URLs, shell arguments, screenshots or logs. A client should read the private `.env` or receive the token through a private in-memory prompt, rather than shell-source the file.

Bearer values are SHA-256 hashed to fixed-size digests and compared with `timingSafeEqual`. A valid token does not bypass local socket/Host checks. `Forwarded` and `X-Forwarded-*` traffic is rejected. A supplied cross-origin/public `Origin` is rejected; an absent Origin supports native local clients. The nginx public route allowlist does not include this endpoint. Operator cookies alone cannot call it.

Successful responses contain `ok`, `event_id`, `receipt_id`, `session_id`, `status`, `expires_at`, and `duplicate`. Default status is `candidate`, also containing `candidate_id`. It does not reveal any note. The candidate appears in the existing local `aiPrompts` list and uses `confirm_ai` to approve/dismiss. An explicit API `auto_confirm=true` event returns `status:"occurred"` after the atomic domain occurrence succeeds. Reveals label API automatic and API human-confirmed sources distinctly from AI.

Identical accepted keys and payloads within the active stream session replay the original acceptance receipt without a second candidate/occurrence. A changed event/context with the same key is a 409 conflict. Wrap-up rejects triggers and invalidates candidates. Retained previous-session keys reject as stale. At most 512 API receipts are kept; current-session receipts are never evicted to admit another key. A full current session rejects new keys with 429 until a new session starts. Older-session receipts can then be evicted. AI candidates do not consume this API receipt allowance.

An interrupted automatic trigger can retain `status:"pending_auto"` if the process stops between reservation and completion. Repeating its key never automatically reruns the occurrence; inspect the local occurrence history before manually resolving uncertainty. Idempotency is not an assertion of exactly-once delivery across arbitrary crashes.

| Result | HTTP status / code |
| --- | --- |
| Accepted candidate, automatic occurrence or duplicate receipt | 200 |
| Missing/invalid Bearer | 401 `invalid_authorization` |
| Forwarded, nonlocal Host or public Origin | 403 |
| Unknown event | 404 `event_not_found` |
| Invalid body/key/context | 400 |
| Wrapped/stale session, definition changed, conflicting key | 409 |
| Event cooldown or existing candidate | 429 `event_cooldown` |
| Admission or receipt/history limit | 429 |
| Token/system unconfigured | 503 `events_api_disabled` |

Admission permits ten authenticated requests per second and forty pre-authentication attempts per second, with a bounded internal queue. Both AI and API acceptance use the same durable cooldown. A duplicate accepted key replays before cooldown admission; HTTP request-rate limits still apply.

## Operator actions and console UI

Send JSON to `POST /api/operator/action` with the existing HttpOnly operator cookie, a same-origin request, and `X-Sealed-Action: 1`. Trigger API Bearer credentials do not grant access to these actions.

| Action | Request fields besides `action` | `result` |
| --- | --- | --- |
| `events_list` | None | `{events:[definition,...]}` |
| `events_presets` | None | `{presets:[{id,label,description,events},...]}`; built-in allowlisted catalog |
| `events_profiles` | None | `{profiles,active_ref,dirty}`; private saved snapshots |
| `events_profile_save` | `profile:{id?,expected_revision?,label,description?,events}` | `{profile}`; save only, no activation |
| `events_profile_activate` | `profile_kind`, `profile_id`, saved `expected_revision` | `{events,active_ref,dirty:false}` |
| `events_upsert` | `event`: complete definition (defaults allowed) | `{event:normalizedDefinition}` |
| `events_delete` | `event_id` | `{id,deleted:true}` |
| `events_import` | `events`: full replacement array | `{events:[definition,...]}` |
| `confirm_ai` | `id`: candidate ID; `approve`: required boolean; optional `context` | Existing occurrence result or `{dismissed:true}` |
| `reset_perception` | None | `{reset:true}`; clears evidence/candidates, retains cooldowns |

Responses use the existing envelope `{ok:true,result:...}`. `GET /api/operator/state` includes definitions in `config.events` and pending candidates in `aiPrompts`. Definitions are full replacements per ID, not JSON patches. Changes invalidate old candidates/model evidence. The operator console includes event creation, editing, deletion, built-in game preset switching and JSON preset import with preview and explicit replacement confirmation. See [game presets](game-presets.md) and [saved profiles](event-profiles.md). Polling preserves unsaved fields. API and AI suggestions show their source and use the same Confirm/Dismiss controls. The API auto-confirm option applies only to authenticated API triggers; picture suggestions always require confirmation.

## Verification boundary

All automated tests use mock Decisions, mock OBS, in-memory stores or temporary private JSON files and local HTTP servers. Run `npm test`, `npm run test:events`, `npm run test:events-browser` and `npm run test:ksp-browser`. KSP compatibility/differential traces remain alongside generic watcher tests. No real provider request, OBS/Twitch connection, credential change or broadcast is required by these commands. Live accuracy and the 2,000 ms success rate remain unverified.

## Operator detection controls

In **Event suggestions**, **Start detection** enables local picture capture and **Stop detection** stops it without restarting the server. Startup is available only with live Decisions and a configured OBS source. A wrapped session must start a new session first. **Reset observations** is a separate action and does not stop detection.

Authenticated `POST /api/operator/action` accepts `{ "action": "perception_set", "enabled": true }` or `false`, using the existing operator cookie, same-origin action header and direct-loopback checks. Success returns `{ "result": { "enabled": true } }` or `false`. Repeated starts/stops are idempotent. Private state includes `integrations.perception.controllable` and `unavailable_reason`; neither includes source credentials.

Stopping closes the screenshot source, cancels picture model requests and fences late results. Note moderation/prediction requests continue. Pending suggestions clear, while cooldowns, API receipts, sealed notes and Debug history remain. Start/stop does not control OBS broadcasting. For the configured-off runtime, launch `tools/start-obs-live.mjs --standby --source="<OBS source>" --port=8788`; it reads existing private OBS settings in memory and waits for the operator action before creating capture.

### Top control panel

The operator console groups frequently used controls at the top: picture detection, Debug recording, observation reset, and the current game profile with a shortcut to profile configuration. Existing profile preview/apply behavior remains authoritative; navigating to profile settings does not apply a different profile.

Private state includes `integrations.debug: {available, enabled}`. The Debug switch uses the existing authenticated `debug_set` action with boolean `enabled`. It changes recording only: it does not start picture capture, stop inference, or delete retained images. Missing or unavailable debug storage disables that control. Neither the Debug control nor the picture control starts a Twitch broadcast.
