# Hosted Test registration record

Registration was verified in the authenticated Twitch developer console on 2026-10-30 after explicit approval to create the new extension. The latest Hosted Test upload and Chrome iframe check are dated 2026-11-01.

- Account: `wilf_lin`.
- Extension: `Sealed Notes`.
- Version: `0.1.0`.
- Public client ID: `x7gtjn04cfbrr1abpsv6r9wvg1d0wa`.
- Types: Panel and Video Fullscreen. No component or mobile type.
- State: **Hosted Test** (the console's translated label is `当前状态：转播测试`).
- Panel: `panel.html`; video: `video_overlay.html`; config: `config.html`.
- Request Identity Link: on. Viewers still control identity sharing in the extension.
- Extension chat feature: off.
- Configuration: custom/self-hosted service.
- Fetch allowlist: `https://notes.wilflin.me`.
- Viewer/config navigation allowlists: `https://notes.wilflin.me/archive`.

[Developer status page](https://dev.twitch.tv/console/extensions/x7gtjn04cfbrr1abpsv6r9wvg1d0wa/0.1.0/status)

The original 2026-10-30 archive contained nine static extension files. Its uploader was `wilf_lin`, MD5 was `0cf134ad21fa9407c78995f0a2e7da0c`, and SHA-256 was `c53a0347e3625e88772e53914e4a3a68a27511d17c07caee80c45e3eaa059777`. This is historical upload evidence, not the current archive.

The 2026-11-01 archive contains 13 files, including the four existing font assets. Its MD5 is `856f98f14eb2dbb1426deeea233687b9`; SHA-256 is `8ef544f3c898bac3d25a06d464fd5fa15c85541e3bf66f61837a9a804c43d8ff`. The Chrome upload checksum matched. The version moved to Local Test and then back to Hosted Test without review or release.

The new extension secret was transferred from its masked console field to the loopback private setup page. No screenshot, tool output, log or document contains it. The saved `.env` was verified at mode 0600; the secret's base64 structure was checked without printing its value. All live-provider flags remain false.

Sealed Notes is now installed as Panel 1 on `wilf_lin`. The existing WarioStream Video Overlay 1 remains unchanged; it was not deactivated or reused. Sealed Notes has not been submitted for review or released. The missing privacy-statement warning concerns review, which is outside this project's scope.

The initial real iframe was blank, with the supervisor keeping it at `display:none`. Audit of Twitch helper `1.28.0` identified a missed `DOMContentLoaded` bootstrap when the helper loaded dynamically; an offline negative control reproduces this failure mode. The packaging tool now injects a synchronous helper before modules into all three packaged HTML files; local source HTML is unchanged. The observed real Twitch popout rendered the form and six KSP moments, and its DOM script list confirmed the helper and the uploaded version's hashed CDN paths. This establishes loading in that instance. New-tab initialization and cross-iframe input automation remain unstable. No real Twitch note was submitted or sealed.

See [the Chrome checkpoint](chrome-e2e-2026-11-01.md) for the 1-test packaging check, 13-check bootstrap fixture with negative control, and isolated Chrome seal/Dismiss/Confirm/archive path. The full local suite passed 271/271 after the helper fix. The isolated path used simulated identity and judgements and does not establish real Twitch submission or AI recognition.

The matching notes certificate was issued successfully, and authorized sudo access succeeded. Independent NPS client ID 6 and the application/NPC systemd services are active. The remote loopback upstream `127.0.0.1:18788/api/archive` returned HTTP 200; the existing port-18787 listener remains in place. Port 8788 now runs the persistent application, not the demo.

Normal TLS verification and public archive access now pass. Every local/network doctor check passes, including denied private routes. The relay helper's final verification returned `ok`, `system_trust_verified` and `public_and_private_checked`. These checks establish the tested relay boundaries, not Twitch iframe/PubSub acceptance.

An earlier HTTPS phase returned `ok`, but a subsequent check found the canonical ACME-only port-80 configuration and a deployment-state fingerprint mismatch. Its cause remains unconfirmed. The repaired helper checks fingerprints after write, reload and state save; the recovery and final verification succeeded.

Real Device Code OAuth consent completed for `wilf_lin` with exactly `moderator:read:followers` and `user:read:chat`. Verified broadcaster/owner/user ID: `1594736759`. Access and refresh tokens were saved privately; no token value is exposed. The temporary setup server on 8789 was stopped and the persistent service restarted. The doctor reported `ready=true`; see `oauth-evidence.md`.

For the 2026-11-01 checkpoint, the persistent application was restarted with the latest code. Six KSP definitions were imported through the operator API only after the definitions were checked empty. Twitch, Decisions, perception and compiler runtime integrations remain disabled. No `.env` values were read or changed and no persistent event-trigger API token was created by these checks. Physical OBS, live AI, a broadcast and PubSub delivery remain unverified. The source bundler includes `.woff2` assets; final source packaging waits for the separate event-management UI work to finish.

## Material 3 local redesign artifact

The latest local `dist/extension.zip` is a newly staged Material 3 build. It has not been uploaded at this checkpoint. The previously uploaded 13-file archive with MD5 `856f98f14eb2dbb1426deeea233687b9` is preserved locally as `dist/extension-hosted-20261101.zip`. Do not use the latest local filename as evidence of the Hosted Test checksum. See `docs/material-3-redesign.md` for the new artifact and local verification.

## 2026-11-02 viewer redesign deployment

The Chrome plugin was connected through `node_repl` (browser profile 用户1), authenticated in Twitch Dev as `wilf_lin`. The extension moved from Hosted Test to Local Test, the new `dist/extension.zip` was uploaded, and the version returned to Hosted Test after the normal transition dialog.

- Version remains `0.1.0`; no review submission or public release.
- Archive: 14 files, including independent `panel.css` and existing local fonts.
- Twitch's displayed upload date: Mon Nov 02 2026; uploader: `wilf_lin`; size: 136.02 KB.
- Twitch's displayed MD5: `4cd1ca8dbb9522da1bcc0f3067bc8554`, identical to the local archive.
- Local SHA-256: `ac53ff771073a78c0f5ebb0f30a8d1e8be8999d4b14f4ac89cbbf6965754c89a`.
- Status page visibly reported `当前状态：转播测试` after transition.

This supersedes the earlier note that the redesigned viewer archive was only staged locally. The deployment verification itself does not establish that a viewer has sent an envelope or that every channel iframe loads successfully.

## 2026-11-02 current-profile moment scope deployment

This upload supersedes the 14-file redesign archive above. Twitch Dev showed Hosted Test after the upload and transition.

- Archive: 15 files, including shared `moment-choices.js`; displayed size 137.26 KB.
- Displayed MD5: `8bd3aded914f4587379211da277bb100`, matching the local archive.
- SHA-256: `d90a6e95072e69f0aa272ecdd6bff81fdef9ef21cc988d8a65b1562c6930191f`.
- The real Chrome popup iframe loaded `/0.1.0/8bd3aded914f4587379211da277bb100/panel.html`.
- The access list already contained `wilf_test` and `evajfk`; no access-list changes were made.

The operator and viewer choices now contain only active-profile definitions and stream-general moments (existing Twitch events and configured builtin start/end). Historical definitions and notes remain stored. The offline moment browser test covers both selectors, profile changes, stale drafts and old envelope labels (33 checks). The full unit suite passed 388/388.

Live limitation: after the final upload, the real popup rendered the form but reported `Failed to fetch`, leaving its moment list loading. Public `/api/archive` returned HTTP 502; local loopback returned 200. The relay had no listener on `127.0.0.1:18788`, although the local NPC process was active. Restarting only the isolated NPC service did not restore the public route during this check. Therefore the final live event groups and real note submission are not verified. No broadcast was started and recognition remained off.

### Relay recovery and real dropdown verification

The later 2026-11-02 recovery supersedes the live limitation above. Restarting the isolated NPC client restored its registered task and loopback port. Public `/api/archive` returned 200. Public `/console` and `/api/events/trigger` remained denied (404). No broker-wide restart, credential change or other tunnel change was made.

After reloading the real Twitch popup in Chrome, its main selector showed exactly two groups: `Current profile` (Launch, Destructive explosion, Landing, Spacewalk / EVA, Flag planting, Parachute deployment) and `Stream general` (End of stream, A raid arrives, A poll ends, A new follower, A new subscription, 15 minutes live, A clip is created, Chat lights up). The loading error was replaced by the normal privacy status. No note was submitted and no stream was started.

### Test-account authorization repair

The broadcaster popup alone did not establish viewer acceptance. The separate Chrome `Test` profile still returned `invalid_authorization`. A temporary reason-only server diagnostic isolated the rejection to the opaque identifier validator; the diagnostic was removed after use. Twitch documents logged-in opaque identifiers starting with `U-`, while broadcaster identifiers can be `U` followed by the numeric broadcaster ID. The old alphanumeric-only validator accepted the latter and rejected the former.

The JWT and whisper-target validators now accept bounded URL-safe opaque identifiers, including hyphens and underscores. Signature, expiry, role and channel checks are unchanged. The regression test covers ordinary viewer/anonymous and broadcaster identifiers, forbidden characters, excessive length and the matching whisper target. `npm test` passed 389/389. After restarting the existing local service, the real Test-profile popup automatically populated six Current profile and eight Stream general options. No credential values or JWT contents were read or logged.

Reference: https://dev.twitch.tv/docs/extensions/#identity

### Already-linked identity toggle deployment

The identity prompt guard was uploaded to Hosted Test. Current archive MD5 is `d6dc45ea46627f7b7e0ded4b08e8f1bb`; SHA-256 is `14764ce01c263066fbabe26a9449ac01d740cdb27af51e8953446d21aa15f76d`. Twitch displayed the matching MD5 and returned to Hosted Test. The real Test-profile popup loaded this CDN hash. With the existing identity grant retained, checking Show my Twitch name left the checkbox selected and opened no dialog. No note was submitted and no permission was revoked.

## 2026-11-02 shared manual presentation deployment

Claude designed the physical envelope stage; the backend and Hosted Test integration use a shared server-owned presentation. The workstation's existing operator action set `reveal.mode` to `manual`, persisted through the normal atomic store. The OBS input named `浏览器` retained `http://127.0.0.1:8788/overlay` and accepted a refresh request (OBS response code 100). Its source screenshot showed the rope and zero-current tally; no synthetic notes were added to the persistent application and no broadcast was started.

- Current Hosted Test archive: 18 files.
- Current MD5: `9170e7c671e89f5afe7401e183ae3860` (verified in Twitch Dev after upload).
- Current SHA-256: `15f2ac2fa3a3e52dbdced9b4f0a22f7d9cc2830582714df3ebd3d7d7bea4cf24`.
- Twitch Dev returned to `当前状态：转播测试`; no public release or review submission.
- 395 unit tests passed; the shared-presentation browser test passed 43 checks; panel browser test passed 33; current-archive bootstrap passed 13. The earlier full browser regression batch also passed.

The first shared-presentation upload (`067f8206996188d51b313d9188df66a0`) exposed a real Twitch restriction: a second HTTP iframe of the extension CDN cannot satisfy its `frame-ancestors` policy. The final Watch view uses a fixed trusted srcdoc document and the shared external renderer, inheriting the parent's policy. It does not run Twitch's helper or receive a JWT. No CSP or identity permission was relaxed.

Real Chrome validation used the separate `Test` profile. The popup loaded the current CDN hash, opened Watch, and showed `0 notes sealed` in the shared stage. The embedded stage had zero buttons and only `video_overlay.js` in its script list. Switching back to Write a note preserved the authenticated state and all fourteen current/general moment choices; returning to Watch worked. No new viewer note was submitted during validation. Non-empty synchronized prepare/open/close, late join, stale responses, and body privacy were verified in the isolated three-view browser fixture, not on a public broadcast.

## 2026-11-02 editable rope endpoints

The endpoint editor and shared geometry were deployed to Hosted Test, still version 0.1.0 and not released publicly. Twitch's upload MD5 matched `a94a07b40d42c2d31a06f1752304e022`; the 18-file ZIP SHA-256 is `991190b026ecaa9cee288e2d5737ed2ccb62da4f58ba6bf272af8fb93613da0b`. The console now exposes Edit layout, Save layout, Cancel and Reset to default. Validation/persistence and local/LAN operator authorization are covered by new tests. Unit suite: 398 pass; endpoint browser: 45 pass; shared presentation: 43 pass; animation: 44 pass; packaged bootstrap: 13 pass.

The live local console saved a left-end vertical change from 0.025 to 0.035; the server readback matched. Reset plus Save restored 0.025. The existing OBS source was refreshed and its URL remained unchanged. No note was opened, no Twitch stream started, and no identity permission or credential changed during this layout check.

For this endpoint-only deployment, the prior `Test` Chrome connection was no longer available. A fresh popup in the remaining broadcaster profile stayed hidden by Twitch's supervisor, so the newest live Watch rendering was not re-verified. The saved-coordinate propagation is verified in the three-surface mocked browser test; the live console save/reset and OBS refresh are separately verified above.

## 2026-11-02 rope physics deployment

The shared stage now uses `rope-physics.js`: fixed-step Verlet integration, gravity, mass-weighted cable constraints and damped envelope pendulums. The old repeating CSS sway was removed. Initial/reduced-motion poses settle statically; idle physics stops requesting frames, and hidden/zero-sized frames defer simulation safely. Endpoint layout and server-owned manual opening remain unchanged.

- Hosted Test archive: 19 files, MD5 `de9125951b745ddf0e92e252e4cf2596` (matched in Twitch Dev).
- SHA-256: `cd86abd0a30ac7ed6d0401fe4c00f1dee723ca4790331996fb2dcf86e389b768`.
- Unit suite: 406/406; physics solver: 8 checks; physics renderer: 13 checks; prior layout/presentation/animation browser checks: 45/43/44 passed after integration; bootstrap: 13 checks.
- Actual local Chrome: changing an endpoint in unsaved Edit layout produced distinct subsequent multi-node SVG poses. Cancel restored the saved layout; no test layout was saved.
- Existing OBS Browser Source refresh succeeded and its source screenshot was captured. Public archive health returned 200.
- No new envelope was submitted/opened, no credentials changed, and no stream was started for this check. Live non-empty viewer acceptance remains separate from the isolated physics/synchronization tests.

## 2026-11-02 overlapping envelopes

Claude updated the shared renderer to compress hanging-envelope spacing and allow stacking on short ropes. Up to 12 covers remain visible; additional envelopes stay in the count. The count tag draws above the stack. Saved endpoints and the existing physical solver were preserved.

- Archive: 19 assets; MD5 `c67e3c146414cf5243e4c854a7746cbc`, matched in Twitch Dev.
- SHA-256: `066504dbe40e179985662b428ce88ebc3a26f0fb743fc6fab2af8edacef372ac`.
- Browser checks: overlay 45, layout 45, shared presentation 43; archive bootstrap 13, all passed with the final renderer.
- Local console reloaded; existing OBS Browser Source refresh returned code 100. No service restart was required.
- Hosted Test only. No test envelopes were inserted into persistent state and no broadcast was started. Non-empty live Twitch rendering was not re-verified; stacking and synchronized opening were checked in isolated browser fixtures.
