# Local acceptance and handoff

The local prototype is runnable. The complete hackathon entry is not accepted until the external steps in `progress.md` are completed.

| Area | Local evidence | External boundary |
| --- | --- | --- |
| Moderation and categories | Unit tests cover all modes, independent answers, fixed-floor rejection and human holds | Live judgement quality is unverified |
| Privacy | Real HTTP tests cover anonymous submission, sealed projections, held reviewer access and public opened-note archive | Real Extension identity consent is unverified |
| Money simulation | Idempotent charge/refund, free allowance, wallet reset and cross-session regression tests | Channel Points/Bits are disabled |
| Conditions | Counter, absolute window, preceding moment, never, end, long-lived, timer/Clip/chat-spike and validated compiler tests | Real signal delivery and actual Codex runtime behavior remain unverified |
| Selection and reveal | Guaranteed overflow, bounded candidate selection, one current card, skip and prediction override tests | Streamer readability and live OBS use need acceptance |
| Twitch infrastructure | Mocked EventSub reconnect/handoff/replay, badge-authenticated commands, durable refresh and private auth journal tests | New extension/account setup and live events are unverified |
| Decisions infrastructure | Mocked multi-question shape, independent refusals, deadlines, bounded admission/coalescing and warmup tests | No real API probe was run |
| Optional perception | Mocked OBS v5 screenshot, private Unicode transcripts and explicit combined confirmation queue tests | No physical OBS capture, microphone transcription or real judgement was run |
| Browser surfaces | See `browser-evidence.md` for exact checks, screenshots and transparent alpha proofs | Hosted Test iframe, PubSub and real viewer latency remain unverified |
| Relay and package | Explicit nginx template, forwarding rejection, clean source extraction and Hosted Test upload | New public certificate, tunnel and nginx deployment remain blocked |

## Run

```sh
npm ci
npm test
npm run test:browser
npm run demo
```

Open `http://127.0.0.1:8788`. The CLI demo automatically seals synthetic notes and declares its scripted moment after six seconds. Open the OBS reveal link to watch. The hub's Play demo button can start another script after the current script and its reveal queue have finished.

`npm start` is the persistent runtime. Live services are explicitly disabled in the local `.env`. Enable them only for an intentional maintainer-run session. Never start broadcasting through the application. Press Wrap up before ending a real stream.

The explicitly approved new extension registration and Hosted Test upload were completed. No review submission, release, channel activation, commits, pushes, remote deployment or broadcast was performed.
