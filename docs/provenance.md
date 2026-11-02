# Reused modules and verification boundaries

Source checkout: `../wariostream`, commit `d584ef58fe9d17d848c4d0ff68bd0d214fd23317` at copy time. Files are copied into this repository. Runtime imports never cross repository boundaries.

Copied infrastructure:

- `server/twitch-credentials.js`, `twitch-auth-log.js`, `twitch-session.js`, `twitch-lifecycle.js`, `file-lock.js`, `lock-holder.mjs`, `env-store.js`: durable private credential lifecycle.
- `server/twitch.js`, `twitch-api.js`: EventSub connection lifecycle and Helix, adapted for notes.
- `server/extension/auth.js`, `identity.js`, `publisher.js`: HS256 JWTs, filtered identity names and a shared coalesced PubSub budget.
- `server/local-request.js`: direct-loopback operator boundary.
- `server/decisions-transport.js`, `decisions-metrics.js`: keep-alive HTTPS and bounded latency metrics.
- `engine/content.js`, `ingress.js`: shared local content screening and bounded admission.

The original transport, credentials, extension and routing suites are retained verbatim under `test/upstream/`. Those reference suites depend on the old game's controllers and fixtures; they are not included by `npm test`. `test/reused.test.js`, `test/twitch.test.js`, `test/judgements.test.js` and `test/http.test.js` exercise the copied infrastructure independently in the new application. Retained reference files are not evidence that the old complete suites ran here.

No old gameplay, branding or saved stream data is reused. No Twitch extension credentials or account tokens are copied from the old project. Only the explicitly authorized OpenAI key is copied into ignored `.env`. The new extension's own secret was later saved privately from its new registration.

The optional speech watcher consumes private local transcript chunks. The optional free-text compiler uses the Codex CLI only after its explicit runtime flag and a viewer matching request. Its child environment is allowlisted without `OPENAI_API_KEY`; its model, tier and reasoning effort are fixed. Local tests inject fake execution and do not establish live model access or actual runtime tool-disable enforcement.

Automated tests mock provider endpoints. Local browser evidence does not establish Hosted Test iframe behavior, real PubSub delivery, streamer acceptance, channel eligibility, OBS capture, live perception accuracy or production performance.

## Fonts

The Material 3 interface uses the locally bundled Instrument Sans under the SIL Open Font License 1.1. Earlier Fraunces and Caveat assets remain in the source/archive for compatibility; the current stylesheet does not load them. The files in `public/*.woff2` are Latin subsets built from the `@fontsource-variable` packages (5.3.0) with fontTools; Fraunces' SOFT/WONK axes are pinned and Caveat is pinned to weight 600. License texts are in `docs/licenses/`. The fonts load from the same origin; no font service is contacted.
