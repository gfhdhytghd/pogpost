# Game presets in the operator console

The operator event panel offers built-in presets as well as custom JSON import. The built-in catalog contains **Kerbal Space Program** (six events) and **General games** (death, victory and boss defeat). Game-specific presets are editable starting points, not claims of live recognition accuracy. Both current built-in presets use `instant` events: one matching reviewed window can suggest an event for human confirmation. KSP descriptions accept clear visible states such as an open parachute, without requiring the entire transition inside the short window. Existing saved profiles keep their saved modes and descriptions; explicitly apply the built-in preset to use its current definitions.

## Workflow

1. Open the operator console's event-recognition section.
2. Choose a game preset and preview its event definitions.
3. Review the replacement warning and explicitly confirm before applying.
4. Edit individual events when the stream needs different visual evidence or timing.

The current profile comes from an explicit, persisted activation record. Edited running events retain that applied identity and show **modified**. Unlinked collections show **Custom events**. Content matching does not assign an identity. Selecting or previewing a preset does not change stored definitions. Manual JSON import remains available.

Applying a profile uses the atomic `events_profile_activate` action. Existing moments, sealed notes and history remain. Switching profile identity or revision clears pending suggestions and picture evidence, including stale work from an A → B → A sequence. Cooldowns and API idempotency history retain their existing semantics. Applying a preset does not enable provider integrations, create an API credential or change a stream session.

## Operator API

`POST /api/operator/action` with `{ "action": "events_presets" }` returns:

```json
{
  "ok": true,
  "result": {
    "presets": [
      { "id": "ksp", "label": "Kerbal Space Program", "description": "...", "events": [] },
      { "id": "generic", "label": "General games", "description": "...", "events": [] }
    ]
  }
}
```

The actual `events` arrays contain complete, validated definitions. This read action uses the existing operator cookie and same-origin action-header requirements. It is not a public preset file server. The catalog uses a fixed registry and does not accept filesystem paths.

Applying a reviewed built-in selection sends `{ "action": "events_profile_activate", "profile_kind": "builtin", "profile_id": "ksp" }`. Saved selections use `profile_kind: "profile"` and require `expected_revision`. See [saved profiles](event-profiles.md) for creation, local draft editing, persistence and version conflicts. Manual JSON import still uses `events_import`. Existing validation, atomic persistence, event limits and watcher synchronization apply. See [the event API](events.md).

To add a maintained built-in preset, add a version-1 JSON preset under `presets/`, validate it with the same event-definition rules and register its fixed catalog entry in `server/event-presets.js`. No frontend game list is hardcoded.

## Initial preset-switching verification checkpoint

The table below records the earlier built-in-only checkpoint. The later saved-profile checkpoint and current commands are in [saved profiles](event-profiles.md).

All automated checks use mocked providers and isolated local storage.

| Command | Result |
| --- | --- |
| `node --test test/event-presets.test.js test/http.test.js test/event-definitions.test.js` | 24/24 pass; six new catalog tests |
| `npm test` | 277/277 pass |
| `npm run test:events-browser` | 58 checks pass; 17 real local operator HTTP actions |
| `npm run test:browser` | 72 checks pass |
| `npm run test:ksp-browser` | 19 checks pass, including confirmation/dismiss/reset |
| `npm run test:material3-browser` | 161 checks pass |
| `node test/extension-bootstrap.mjs` | 13 checks pass on the staged shared-style ZIP |

The event browser checks cover selection without mutation, preview/cancel, polling preservation, explicit editor discard, preserved pasted JSON, failed apply and retry, edited collections becoming Custom, switching back to KSP, and catalog loading failure/retry. Existing event-management checks remain.

Actual Chrome on an isolated in-memory server switched KSP → General games → KSP. Selecting General games left six active events in place until Apply preset was clicked; applying changed the collection to three events, and switching back restored six. The temporary browser/server were closed after verification. The persistent console was checked separately: the catalog loads and the current KSP definitions remain unchanged. Twitch, Decisions, picture/sound and condition matching all remain Off.

The catalog API is protected by the existing operator cookie, action header, same-origin and direct-loopback checks. Tests reject public/forwarded origins and caller-supplied filesystem paths. Listing causes no store writes; applying through `events_import` preserves earlier notes, balances, moments and history.

![Preset preview in the isolated local application](../shots/game-preset-switch.png)

Changed implementation files: `server/event-presets.js`, `server/http.js`, `public/console.html`, `public/console-events.js`, `public/console.js`, `public/styles.css`, `test/event-presets.test.js`, `test/events-browser.mjs` and the existing KSP browser assertions adapted for the new read-only catalog request and generic integration heading. The game label comes from the actual event definitions, not the legacy capture profile.

No real `.env` values, provider connections, broadcast, public preset-file routes or remote deployment were added. The operator UI is served locally; it is not included in the Twitch extension ZIP.
