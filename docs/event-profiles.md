# Saved event profiles

A saved profile is a named snapshot of event definitions. Saving a profile and activating it are separate actions. This lets the operator prepare another game's events without changing recognition during the current stream.

## Intended workflow

1. Choose **New profile**.
2. Name the profile and start from an empty collection or a copy of current events.
3. Edit its events in the local draft.
4. Choose **Save profile**.
5. Select the saved profile, review the preview and choose **Apply** to activate it.

Built-in KSP and General games collections are read-only templates. Save a copy to customize them. Existing saved profiles can be edited and saved as a new revision. This checkpoint does not add profile deletion.

Changes to running event definitions do not silently overwrite saved profiles. A profile's name, identity and applied revision come from an explicit activation record, not from matching event text. Different profiles can contain identical events without losing their identity. Ordinary JSON event imports remain available and detach the running collection from its prior profile. An explicit `EVENTS_PRESET_FILE` startup override also imports its configured definitions and detaches the prior reference. Without that override, an explicitly applied empty profile remains empty after restart.

## Persistence and validation

Profiles live in private top-level store fields rather than the viewer-facing configuration. Existing atomic snapshots and rollback apply. Older stores initialize the missing profile collection and activation record without replacing existing notes, moments, history or runtime state.

Limits: 20 saved profiles, 12 events per profile, 80 Unicode characters in its label and 300 in its description. Saved-profile labels must be unique after NFKC normalization and case folding; a profile can keep its own name when updated. Built-in and saved entries are distinguished by source. Event definitions use the same existing validation as running events. The existing limit of 40 retained moments also applies when activating a collection; saving a snapshot does not bypass it. A profile that would exceed this capacity is retained but activation is refused with a clear error, leaving current events and history unchanged. Unused moments can be removed through broadcaster configuration; this feature does not automatically delete historical moments. IDs, revision and timestamps are server-managed. An existing profile update requires its expected revision; a stale update fails with HTTP 409.

## Operator contract

All actions use `POST /api/operator/action`, the operator cookie, same-origin request and `X-Sealed-Action: 1`. They remain direct-loopback only.

| Action | Fields besides action | Result |
| --- | --- | --- |
| `events_profiles` | None | `{profiles,active_ref,dirty}` |
| `events_profile_save` | `profile:{id?,expected_revision?,label,description?,events}` | `{profile}` |
| `events_profile_activate` | `profile_kind:"builtin"|"profile"`, `profile_id`, `expected_revision?` | `{events,active_ref,dirty:false}` |

A saved profile is `{id,revision,label,description,events,created_at,updated_at}`. New saves omit `id` and `expected_revision`; the server creates a `profile-UUID` identity and revision 1. Existing saves require both. Activating a saved profile requires its expected revision; a built-in selection uses its fixed `ksp` or `generic` ID.

`GET /api/operator/state` includes the private `event_profiles:{profiles,active_ref,dirty}` projection. The existing `events_presets` action continues to serve only the fixed built-in catalog. Viewer EBS/config projections, archive and overlays do not receive saved-profile records or activation metadata. Once explicitly activated, the selected event definitions become ordinary `config.events` and retain their existing viewer-facing projection.

The activation record retains its applied label/revision and a canonical hash of the applied events. Editing running events marks that record dirty without changing the saved snapshot. Saving a newer snapshot does not silently activate it; the UI can show a newer saved revision awaiting Apply.

Applying a different profile kind, identity or revision is an observation boundary, even when its event definitions match. Pending candidates are cleared, and the picture watcher, candidate ledger and queued occurrence checks reject results captured under the prior profile context. Cooldowns and API idempotency receipts remain. Saving a draft does not change that context. Reapplying the same identity/revision does not create a new profile context.

## Verification

Tests and previews use only local in-memory or temporary JSON stores and mocked providers. No live Decisions, OBS or Twitch connection is part of this feature.

| Command | Result | Coverage |
| --- | --- | --- |
| `npm test` | 319/319 pass | Existing suites and the new profile/fence tests |
| `node --test test/event-profiles.test.js` | 21/21 pass | Validation, revisions, persistence, private projection, rollback and capacity |
| `node --test test/event-profile-fence.test.js` | 21/21 pass | Queued candidates/confirmations/auto triggers/model results and A → B → A context changes |
| `npm run test:events-browser` | 91 checks pass | Draft CRUD, named save/apply, duplicate names, same-content identities, conflict recovery and old event workflows |
| `npm run test:browser` | 72 checks pass | Existing note lifecycle and transparent overlays |
| `npm run test:ksp-browser` | 19 checks pass | KSP human confirmation, dismissal and reset |
| `npm run test:auth-browser` | 19 checks pass | Existing private authorization UI |
| `npm run test:material3-browser` | 161 checks pass | Light/dark layouts, sampled contrast and transparency |

The profile context is a private, persisted monotonic epoch plus the applied reference. Actual canonical event changes and reference changes advance it. An A → B → A sequence therefore cannot revive an earlier candidate. The independent real-HTTP reproduction now returns `409 stale_profile_context`, with zero occurrences and zero archived notes. Merely saving a draft or reapplying the same identity/revision/definitions does not advance the context.

### Actual Chrome check

Chrome used a separate loopback application on port 8793 with a temporary 0600 JSON store and simulated providers. Through its UI, the check created **Chrome flight profile**, started blank, added one event and saved it. The running KSP collection stayed at six events until **Apply profile** was clicked. Activation then showed the saved name and one event. The Node process was stopped and started again against the same JSON file; reloading Chrome restored both the profile name and its event. This fixture is separate from the persistent application and contains no real credentials or user notes.

A new normal Chrome window was opened for the persistent operator console at `http://127.0.0.1:8788/console`, with the **New profile** editor open and ready to name. Its existing six KSP event definitions remain in place, and the integrations are Off. Since the pre-profile store had no explicit applied identity, the collection is correctly shown as **Custom events** until the operator explicitly saves or applies a profile. No synthetic test profile was saved into this persistent application.

### Visual review

The light desktop editor, dark editor and 390 px dark layout were captured from the isolated fixture and visually reviewed. The narrow editor has no horizontal overflow. Draft event forms disable profile saving and competing edit actions until the event is added, updated or cancelled, preventing silent loss of pending form input.

- [New profile editor](../shots/profile-editor.png)
- [Dark editor](../shots/profile-editor-dark.png)
- [Narrow editor](../shots/profile-editor-narrow.png)
- [Restored named profile](../shots/profile-restored.png)

### Implementation files

- Backend: `server/event-profiles.js`, `server/event-presets.js`, `server/domain.js`, `server/http.js`, `server/index.js`, `server/events.js`.
- Frontend: `public/console.html`, `public/console-events.js`, `public/styles.css`.
- Tests: `test/event-profiles.test.js`, `test/event-profile-fence.test.js`, `test/events-browser.mjs` and related judgement assertions.
- Generic scene compatibility: `server/judgements.js` clarifies that in-game death/victory/result overlays still count as gameplay, while navigation, pause and loading remain menus. This is covered with mocked judgement tests and does not establish live accuracy.

No profile deletion, live provider probe, remote deployment, Twitch asset upload, `.env` value change, commit or push was performed. The source bundle and staged shared-style extension archive were rebuilt locally.

## Moment choices

The operator desk and the viewer panel offer only two groups of moments. Both are built by `groupMomentChoices` in `public/moment-choices.js`. The server sends the result as `moment_groups`; the UI falls back to the same helper when an older server omits that field.

- **Current profile**: moments whose IDs are in the running `config.events`, in definition order. `first-death` appears here only while a profile that defines it (such as General games) is running.
- **Stream general**: Twitch moments and the built-in `start` and `end` moments. `first-death`, `never`, sample game moments and old profile moments are never offered here.

Other moments stay in storage. Existing notes keep their `moment_label`, and history, cooldowns and sealed words are unchanged.

- **Operator desk.** **Make it a moment** shows the two groups with their Declare moment buttons. There is no Other & historical list and no separate Add moment form; add events through a profile instead.
- **Viewer panel.** **Open when…** and **Only after this moment** show the same two option groups. When a profile switch removes the moment a viewer chose, the panel keeps the draft words. It shows **Choose a moment again** and blocks sealing until the viewer picks a moment, so a draft is never silently bound to another moment.

### Verification

`node test/moments-browser.mjs` runs 33 checks over a real local HTTP fixture, the local Twitch mock and in-memory storage:

- KSP, General games, custom and empty definitions, switched while both pages are open;
- the desk list, panel main list and panel after-condition list agree;
- no First death, Never, sample or other-profile moments are offered;
- a draft is kept and re-prompted after its target disappears;
- an old envelope keeps its label on both surfaces, with its words hidden;
- no external requests.
