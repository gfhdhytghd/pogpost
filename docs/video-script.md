# Demo video and final recording script

## Delivered local recording

Run `node tools/record-demo.mjs` from the project root. The command creates:

- `artifacts/sealed-notes-local-demo.mp4`: a captioned, silent 1920×1080 H.264 recording under three minutes.
- `artifacts/local-demo-recording.json`: exact duration, scene timings, frame counts, and `ffprobe` results.
- `artifacts/local-demo-verification-frame.png`: a frame decoded from the finished MP4.

The recording uses real Chromium pages and the real local HTTP application. It uses an in-memory demo store, a mocked `Twitch.ext`, deterministic demo judgements, and simulated payments. It does not load `.env`. Chromium and FFmpeg receive a minimal environment without provider credentials. The browser blocks requests outside the loopback application.

Verified output: **104.00 seconds**, **1920×1080**, **24 fps**, **H.264**, **1,387,164 bytes**, and no audio stream. FFprobe inspected the finished file. FFmpeg decoded the frame at 35 seconds. Visual inspection confirms that the frame shows the prediction reveal, the CALLED IT verdict, and the LOCAL DEMO caption.

The persistent **LOCAL DEMO** caption identifies the recording. The reveal fixture holds cards for recording and advances them manually. Production presentation defaults remain unchanged. No copyrighted game footage, music, or audio is included.

This asset demonstrates the local product flow. It does **not** prove Twitch Hosted Test, real Extension PubSub delivery, live Decisions judgements, an OBS Browser Source, a broadcast, or real viewer latency. It is not the final Twitch-running submission video.

## Local scene order and suggested narration

The recording has embedded captions and no audio. This narration can be recorded later.

| Scene | Suggested narration |
| --- | --- |
| Pitch | “Sealed Notes lets a viewer write something private for a future moment on stream.” |
| Compose | “Choose advice, prediction, joke, or encouragement. Pick a moment. Every payment here uses test currency.” |
| Sealed receipt | “When the note is sealed, the text disappears, even from the author's panel. It never enters chat.” |
| Operator confirmation | “The streamer decides when a moment happens. The prototype does not read game state.” |
| Prediction | “The envelope opens on the canonical overlay. A prediction can receive a verdict. This verdict is a local demo fixture.” |
| Private notice | “Only the author receives this notice. The local fixture applies a nine-second viewer latency.” |
| Advice | “Each category has its own color, icon, and subtitle.” |
| Joke | “A short joke becomes a shared moment.” |
| Encouragement | “A little support arrives when it matters.” |
| Human review | “Uncertain moderation holds a note before any charge. A moderator can reject it.” |
| Never-opened sample | “At wrap-up, the stream can open a sample of moments that never happened.” |
| Never-opened count | “The reel reports the count. The test payment is refunded.” |
| Archive | “Opened notes become a public archive, with a filter for each stream.” |
| Scope | “Built with Codex. Runtime judgement integration uses the Decisions API with gpt-6-luna. This recording uses offline fixtures.” |

## Final submission: live inserts still required

The maintainer must start the broadcast. The prototype must remain in Hosted Test. No broadcast starts as part of this recording command.

Use the local recording as a rough cut. Replace the corresponding local scenes with these verified live inserts. Keep the finished video below **180 seconds**.

| Insert | Target length | Capture | Evidence boundary |
| --- | ---: | --- | --- |
| Twitch context | 8 seconds | The live `wilf_lin` channel with the Sealed Notes extension visible in Hosted Test. Show the channel and extension together. | Establishes that Twitch is running. A local imitation does not satisfy this shot. |
| Real viewer flow | 15 seconds | Compose and seal a harmless note in the actual extension panel. Show TEST MODE, then the private receipt. | Uses a Twitch Extension authorization lifecycle. Do not expose a token or a private note after sealing. |
| Canonical live reveal | 12 seconds | The maintainer declares the moment. Capture the OBS Browser Source reveal and the viewer's private notice. | Verify the author receives the notice. Keep real latency claims tied to a measured observation. |
| Runtime Decisions | 8 seconds | After explicit authorization for a live call, show a redacted result containing model, verdict, and measured latency. | A local fixture is not a live Decisions result. Do not show credentials or unrevealed note text. |
| Development with Codex | 8 seconds | Show a real Codex development interaction and the related source or passing test result. Explain one concrete change, such as sealed-body projections or moderation before charging. | The current end card states tool use. This insert demonstrates how development used Codex. |

If these inserts replace local scenes, the edit remains comfortably below three minutes. Use the same captions where their claims match the captured evidence. Replace **LOCAL DEMO** only on shots that actually show the verified live environment. Keep TEST MODE labels visible on every priced surface.

## Suggested final edit

1. Open with the pitch and live Twitch context.
2. Show the real viewer composition and hidden receipt.
3. Show human confirmation, the canonical reveal, and the author-only notice.
4. Show the remaining category colors, human review, and wrap-up.
5. Show the public archive.
6. Explain the bounded Decisions calls and the concrete Codex development example.
7. End with the product name and the simulated-payment / Hosted Test status.

The required live inserts remain unrecorded. No local screenshot or recording should be presented as proof of those inserts.
