# Event management UI implementation brief

## Scope

Implement the generic event management UI in the existing local operator console. Preserve the current visual direction, typography, colors, note composition and reveal surfaces. The backend is complete; use the existing structured actions. Keep all product UI, code comments and project documentation in English.

Own `public/console.html`, `public/console.js`, narrowly scoped styles in `public/styles.css`, and new frontend-only modules if useful. Add focused offline UI tests and evidence. Preserve existing uncommitted work. Do not edit backend modules, presets, credentials, deployment configuration or the extension packaging tool. Do not commit or push. Do not generate a token, read/write real `.env`, restart services, call real Decisions/OBS/Twitch, or control the shared user Chrome session. Use an isolated mock/local browser fixture for verification. Coordinate a backend gap instead of inventing an endpoint.

## Authoritative references

Read `docs/events.md`, `docs/ksp-live-test.md`, the current `server/http.js` action envelopes, and `server/event-definitions.js` validation before coding. Frontend scope is explicitly authorized. Existing backend remains owned by the primary task.

Definitions persist in `config.events`, at most 12. Each event has:

- `id`: required `^[a-z][a-z0-9-]{0,59}$`, stable identifier.
- `label`: required, at most 100 Unicode characters.
- `description`: required broadcaster-written visible-evidence criteria, at most 300 Unicode characters.
- `mode`: `persistent` or `instant`.
- `min_confidence`: 0..1, default 0.85.
- `cooldown_s`: integer 1..3600, default 30.
- `auto_confirm`: boolean, default false. Explain clearly: only authenticated external API triggers can automatically occur; AI picture candidates still require human confirmation.

## Required UI

1. Show a concise event definition list with count/12, label, mode, confidence threshold, cooldown and automatic-API status. Include empty/loading/error states.
2. Add/create and edit forms for all definition fields, with useful labels, safe defaults and Unicode-aware counters. Keep ID stable during editing or explicitly implement rename as a separate add/delete workflow; never silently rename it.
3. Delete through the backend action. Explain that removing recognition leaves existing note/moment history intact. Refresh canonical data only after a successful response; show backend errors without losing edits.
4. Import versioned preset JSON `{version:1,events:[...]}` using `events_import`. Support choosing a local JSON file and/or pasting JSON with bounded input. Backend remains authoritative; replacement must be explicit. KSP and generic presets are in `presets/`. Do not assume those filesystem paths are web-served. If adding built-in preset buttons, derive frontend data from those exact files and test equality, or ask for a read-only backend contract; do not fetch nonexistent routes.
5. Present the shared candidate queue as event suggestions, distinguishing `source:'ai'` and `source:'api'`. Preserve timestamp/evidence display, Confirm and Dismiss behavior. Do not expose images, raw provider text, tokens or sealed note bodies in candidate metadata.
6. Provide an observation reset control for the generic system. Reset clears evidence/candidates while retaining cooldown and idempotency history. This must not be limited to a KSP-only label/profile.
7. Preserve accessible labels, keyboard operation, disabled/busy state and mobile/narrow layout. Use existing textContent/el rendering; treat descriptions/imported JSON as data.

Do not add a browser token manager. `POST /api/events/trigger` needs a separate Bearer token and is intentionally not authorized by the operator cookie. A UI button must not pretend it can call that API without the required credential.

## Existing API contract

Bootstrap `GET /api/operator/bootstrap` establishes the existing HttpOnly operator cookie. `GET /api/operator/state` returns definitions in `config.events`, candidates in `aiPrompts`, and integration status. Use the console's existing same-origin API helpers.

POST `/api/operator/action`, with the cookie and `X-Sealed-Action: 1`:

| action | Fields | Response result |
| --- | --- | --- |
| `events_list` | none | `{events:[...]}` |
| `events_upsert` | `event`: complete definition | `{event:normalizedDefinition}` |
| `events_delete` | `event_id` | `{id,deleted:true}` |
| `events_import` | `events`: full replacement array | `{events:[...]}` |
| `confirm_ai` | `id`, boolean `approve`, optional `context` | occurrence result or `{dismissed:true}` |
| `reset_perception` | none | `{reset:true}` |

Envelope: `{ok:true,result:...}`. Errors contain `{ok:false,error,message?}`. Unknown IDs are 404; invalid definitions are 400; capacity is `event_limit`; stale candidates can be 404/409. Candidate fields include `id`, `moment_id`, `label`, `source`, `needs_confirmation`, `observed_at`, `created_at`, `expires_at`, `evidence`.

## Current verified state (2026-11-01)

The primary task restarted `sealed-notes.service` after the generic backend changes and imported the six KSP definitions through operator actions. Formal runtime picture/Decisions/Twitch integrations remain disabled. No real event API token was created by this work.

The primary task installed Sealed Notes as a new Twitch Panel 1, leaving the existing WarioStream video overlay unchanged. A real Hosted Test helper bootstrap defect was found and fixed in `tools/package-extension.mjs`: all three packaged HTML pages now load the Twitch helper synchronously before modules, without changing local-demo HTML. Updated ZIP MD5 is `856f98f14eb2dbb1426deeea233687b9`, and the extension is back in Hosted Test. Do not overwrite packaging changes or move it toward review/release.

A temporary isolated Chrome test server demonstrated seal privacy, authenticated event API candidate creation, idempotent retry, cooldown rejection, Dismiss without reveal, and human Confirm followed by overlay/archive reveal. These used simulated identity/judgements. Real Twitch iframe now renders the panel, but cross-iframe input automation remains under investigation. Physical OBS, live Decisions recognition and live broadcast acceptance remain unverified.

## Acceptance

Run meaningful isolated UI checks for create, update, delete, invalid/over-limit input, import replacement, server-error preservation, source badges and confirmation/reset controls. Keep existing browser flows passing. Report changed files, exact test commands/results and screenshots. Do not call the work live-accepted merely because mocks pass.
