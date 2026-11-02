# Recognition debug mode

Open `http://127.0.0.1:8788/debug`, or choose **Debug** in the operator desk. The page uses the existing Material You 3 style. Its local bootstrap refreshes the operator/debug cookies after an application restart. This page and every data/image endpoint are restricted to direct loopback access. Public hosts, forwarded traffic and public Origins are rejected.

## Recording a new rehearsal

1. Turn **Debug recording** on. The explicit choice survives restart; first use defaults to off.
2. Start picture recognition separately. The debug switch never starts OBS, Twitch, Decisions or a broadcast.
3. Perform the game action. The private timeline records all successfully observed frames while enabled, including images that are never sent to the model.
4. Inspect **All frames**, **Screening**, **Review**, or **Requests**. A frame links to its associated single-image screen and five-image review. Select a request to see the exact ordered frame IDs, images, model choices/confidences and normalized result. Older/Newer navigation pages through retained images.
5. Stop recognition when the rehearsal ends. Debug history remains readable. Turning debug off stops new recording and retains existing history; already-started requests may finish their allocated records.

Earlier game images cannot be recovered: recording starts only when explicitly enabled. Existing control-panel/test screenshots are not captured-game evidence. Debug mode adds observation only; it does not fix the previously found KSP transition/persistent mismatch or the 1 Hz screening blind spot.

## What is recorded

- Each frame receives a global UUID, a monotonic sequence, original capture ID, local `captured_at`, actual PNG dimensions, byte count and private image URL. `captured_at` is the OBS adapter's observation-completion time, not KSP simulation time.
- Each screen/review records its ordered frame UUIDs and immutable event-definition snapshot. Screening sends one image; adaptive review sends the five images frozen before screening. Missing images are explicit rather than replaced by newer captures.
- Model records include the known structured answer fields (`name`, `type`, bounded choice, confidence and refusal/invalid markers), normalized result, model identifier, latency, fixed transport outcome and token usage when returned. Unknown free-text fields, refusal text, raw HTTP errors, credentials, note bodies and request bodies are not stored. This is structured model output, not a full provider-wire dump.
- Decisions record screening gates, evidence counts (`yes_count`, `no_count`, `armed`, `latched`), candidate acceptance/suppression, resets and stale-result discards. Request-linked resets/discards explain why a returned model result was not used.
- Outcomes distinguish `timeout`, `http_error`, `malformed_response`, `transport_error`, disabled/admission failures and provider success. A successful API response can still normalize to unknown or fail the evidence rules.

Images are ordinary private PNG files, not base64 in JSON. Saved debug copies remain local. The existing recognition flow still sends selected frames to OpenAI when live recognition is explicitly enabled. No new provider request is made merely to view history.

## Storage and retention

Files live under `data/debug/`: directories mode 0700, PNGs and atomic index mode 0600. The source bundle excludes this entire directory.

Default bounded limits:

| Item | Limit |
| --- | --- |
| Retained frames | 5,000 |
| Retained image bytes | 512 MiB |
| Request records | 5,000 |
| Decision records | 10,000 |
| Serialized metadata | 32 MiB |

At 5 Hz, the frame-count limit spans about 16 minutes 40 seconds; the byte limit can expire images sooner. Oldest images expire at the image limit. Oldest request/decision records expire at the count/metadata limit, while retained frame records keep their sent-to-screen/review IDs. The UI shows capacity, expiration, dropped-image and storage-error counters. A missing request detail returns 404; a missing image returns 404. An initial image write may briefly be unavailable. Authentication and temporary network failures are distinct from expiration.

Capture and inference do not await image writes. The bounded writer queue drops new debug images when overloaded and increments `dropped_frames`; it never changes model decisions or disables recognition. This is not a promise of lossless archival storage under I/O failure.

Normal shutdown flushes metadata. After an unexpected interruption, pending requests become `interrupted`. Completed PNG writes without durable index entries can be recovered with `capture_id:recovered-after-interruption`; their timestamp comes from file modification time, and prior request association cannot be reconstructed. Corrupt/symlink history fails closed with a fixed storage error; it is preserved rather than overwritten.

## Private API contract

All API routes require the existing `sealed_operator` cookie, direct loopback and a same-origin/absent Origin. Debug HTML/assets additionally use the narrowly scoped HttpOnly `sealed_debug` cookie. `/debug` can redirect through the existing local bootstrap; no image or model history is served before authentication.

- `GET /api/operator/debug?limit=100&before=<frame-seq>`: `{enabled,limits,stats,frames,requests,decisions,next_cursor}`. Limit 1–250.
- `GET /api/operator/debug?frame_id=<uuid>`: selected frame and associated requests/decisions.
- `GET /api/operator/debug?request_id=<uuid>`: selected request and its associated frames/decisions.
- `GET /api/operator/debug/frame/<uuid>`: cookie-protected PNG, `Cache-Control:no-store`.
- `GET /api/operator/debug/request/<uuid>`: `{request}`.
- `POST /api/operator/action`, body `{action:"debug_set",enabled:true|false}`, JSON with `X-Sealed-Action:1`: toggle recording. This does not start capture.

Frames include `id,seq,capture_id,captured_at,width,height,bytes,image_available,image_url,screen_request_ids,review_request_ids`. Requests include `id,seq,stage,started_at,finished_at,frame_ids,missing_frames,definitions,status,model,latency_ms,raw,normalized,usage`. Limits/stats expose image and metadata retention and cumulative expirations. No debug state is added to viewer/archive projections or the public relay allowlist.

## Verification

Unit and browser tests use synthetic images, mock Decisions/OBS, temporary private recorder directories and real loopback HTTP. They do not read `.env` or use the test Twitch account.

```sh
npm test
node test/debug-browser.mjs
npm run test:browser
npm run test:auth-browser
npm run test:material3-browser
```

`test/debug-pipeline.test.js` exercises the actual application, Judgements and recorder together. It verifies all captures, exact 1/5-image associations, raw and normalized outputs, timeout/HTTP/malformed/error separation, candidate confirmation boundaries and immunity to diagnostic I/O failures. Recorder/HTTP tests additionally cover persisted opt-in, quotas, Chinese metadata size, permissions, interrupted writes, symlinks, public-Origin/forwarded denial and private asset aliases.

Final verification checkpoint: `npm test`364/364; Debug browser32; main browser72; private authorization19; Material3 browser161. Browser proof uses generated synthetic images and structured mock model answers. The persistent service serves `/debug`; recording is explicitly enabled for the next rehearsal, while picture recognition remains disabled and no game images have been recorded. The actual running-service screenshot is `shots/debug-live-ready.png`; the gallery/request examples in `shots/debug-{overview,request,image-states,dark,narrow}.png` are mocked fixtures.

The separate Twitch Chrome window was found by title, but its account identity and automation connection remain unverified: browser access host is unavailable and desktop preview reports a tool error. No test-account actions were performed.
