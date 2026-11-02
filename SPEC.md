# Sealed Notes — product & build spec

Codex × TwitchCon hackathon entry. Deadline: **2026-11-02 14:00 PST**. This is a new, standalone project. It
**reuses proven modules from `../wariostream`** (copy them in; do not import across repos), but shares no gameplay,
branding or data with WarioStream.

## 1. Pitch

Any viewer can write a short note privately and **seal it to a moment**: *open when you beat this boss* ·
*open when you die* · *open when you find the key* · *open at the end of stream*. The note can be advice, a
prediction, a joke or encouragement. When the moment happens, the seal breaks on stream. The streamer reads the note
aloud and reacts, and the author is credited by name.

This needs:
- private submission (never in chat);
- moments that the streamer and Twitch can actually observe;
- streamer-owned rules for moderation, categories and prices;
- OpenAI's **Decisions API** for fast, bounded judgements: moderation, classification, choosing which note to open,
  and judging whether a prediction came true.

## 2. Hard constraints (read first)

- **No game integration.** We cannot read or control game state. A moment happens because of:
  - a Twitch event;
  - a streamer or moderator declaring it;
  - an AI perception of the OBS picture or the microphone, and only with human confirmation.
- **The broadcaster channel `wilf_lin` is a regular channel, not Affiliate/Partner.** It has no Channel Points and
  no Bits. All payments run in **simulated currency mode**.
  - The real Channel Points and Bits code paths are implemented and covered by mocked tests, behind a flag that stays
    off.
  - Every surface that shows a price shows a **"TEST MODE — no real charge"** label.
- **The extension runs only in Hosted Test.** It is never submitted for review or released.
- **Video overlay extensions render only while the channel is live.** The maintainer can go live for testing.
  Never start a broadcast yourself.
- **Hackathon rules.**
  - Everything in the repo and the UI is in English.
  - No copyrighted assets.
  - No author or attribution lines for any AI assistant in commits, docs or PRs.
- **Models.**
  - All code is written with Codex `gpt-6.1-sol` (high).
  - Runtime judgements use the Decisions API (`gpt-6-luna`).
  - Optional runtime generation, if any, uses `gpt-6-astra` at `service_tier=ultrafast`, effort `low`, through the
    Codex CLI on the ChatGPT login.
  - Codex child processes must never inherit `OPENAI_API_KEY`.
- **Secrets** live only in `.env` (gitignored, mode 0600). Never print them, log them, put them in screenshots, or
  commit them.

## 3. Users and surfaces

| Surface | Who | Purpose |
|---|---|---|
| **Extension panel** (`panel.html`) | Viewers | Write, categorise, pick a moment, pay (simulated), see "sealed" receipts and their own notes' status |
| **Extension video overlay** (`video_overlay.html`) | Viewers | Small "N notes sealed" chip; private "your note was opened" toast, timed to the viewer's latency |
| **Extension config** (`config.html`) | Broadcaster | Rules: moderation, categories, moments, prices, free tier |
| **Operator console** (`/console`, loopback only) | Streamer / mods on the streamer PC | Declare moments, confirm AI-detected moments, review queue, veto, manual reveal, wrap-up |
| **OBS overlay** (`/overlay`, Browser Source 1920×1080, transparent) | Everyone, including VODs and clips | The canonical reveal: seal cracks, envelope card, name, note, verdict stamp |
| **Public archive** (`/archive`) | Anyone | Opened notes per stream; read-only |

## 4. Core loop

1. **Moments are declared.** Before or during the stream, the broadcaster lists upcoming moments in config or the
   console. Examples: "Margit", "Find the key", "Finish the game". Built-in moments are always available (§6).
2. **A viewer seals a note.** In the panel they:
   - write up to 140 characters;
   - choose a category (or let the AI choose, §8);
   - pick a moment;
   - optionally choose "show my name" (`Twitch.ext.actions.requestIdShare()`).
3. **Gate.** The note is moderated and classified **before** any charge (§7, §8). The outcome is approved, held for
   human review, or rejected. Rejected notes never cost anything.
4. **Pay** (simulated, §9). Free if the free tier applies; otherwise simulated Channel Points or simulated Bits at the
   broadcaster's prices.
5. **Sealed.** The note's content is now invisible to everyone, including the author's own UI. The author sees
   "Sealed · for: Margit · #a1b2" and a counter. The OBS chip shows "12 notes sealed for Margit".
6. **The moment happens** (§6). The condition engine marks it. AI-detected moments need a one-tap confirmation.
7. **Selection.** If several notes are waiting on the moment, pick at most N (default 3, configurable):
   - guaranteed (paid) notes first;
   - then a Decisions pick of the most fitting notes, given the moment and context (§8).
8. **Reveal.**
   - The OBS overlay plays a seal-break animation, then shows the envelope card: colour + subtitle by category,
     the @name or "a viewer", the moment, and the note. One note at a time, about 8 s each; the streamer can skip.
   - The author gets a private toast, delayed by their `hlsLatencyBroadcaster` so it is not a spoiler.
   - Optionally, one announcement line goes to chat.
9. **Prediction verdict.** For notes in the prediction category, Decisions judges came-true / missed / unclear
   against the moment context. The card stamps **CALLED IT** or **MISSED**, and the streamer can override.
10. **Wrap-up.** The streamer presses "Wrap up" before ending the stream (not on `stream.offline`, because nobody
    sees the overlay after that).
    - Any end-of-stream notes are opened.
    - A "never opened" reel shows the count, plus up to 3 notes whose moment never came (the "this never happened"
      gag).
    - Long-lived notes (§6) stay sealed.

## 5. Data model (SQLite via `node:sqlite`, or a JSON store if simpler)

```
Note {
  id, channel_id, stream_session_id,
  author_opaque_id, author_user_id?, display_name?,  // name only if identity shared and filter-passed
  body (≤140), category_id, category_source: viewer|ai|streamer,
  moment_id, condition (spec, §6),
  status: pending_review | held | rejected | sealed | revealed | expired | refunded,
  moderation { verdict, source: decisions|rules|human, confidence, latency_ms },
  classification { category_id, confidence, latency_ms },
  payment { mode: free|sim_points|sim_bits|points|bits, amount, txn_id, refunded_at? },
  guaranteed: bool, created_at, sealed_at, revealed_at?, prediction_verdict?
}
Moment { id, channel_id, label, kind: builtin|declared|ai, long_lived: bool, occurred_at[], confirmed_by }
ChannelConfig { version, moderation{}, categories[], moments[], payments{}, reveal{} }
```

## 6. Moments and conditions

**Reliability tiers.** The tier is shown on the card ("Streamer confirmed", "AI-detected · confirmed by mod").

| Tier | Examples | Source |
|---|---|---|
| Twitch events (deterministic) | stream reaches N minutes; raid received; new follower/sub (when available); poll ends; a clip is created; chat activity spike | EventSub + Helix |
| Declared (reliable, manual) | "Margit", "Find the key", "Finish the game", custom | Broadcaster/mod: console hotkey, or a chat command from mods only, e.g. `!moment margit` |
| AI-perceived (probabilistic) | death screen; victory screen; boss health bar gone; streamer blames the game; streamer laughs | Decisions on OBS frames and mic (§8); **needs a confirmation tap** |
| Built-ins | end of stream (Wrap up); first death (AI or declared); "never" (opened at wrap-up if the moment never happened) | Engine |

**Composites** (MVP scope: the counter and window only):
- "the 3rd time X happens";
- "X before minute N" (the note expires otherwise);
- "the first X after Y".

**Long-lived notes.** Moments flagged `long_lived` (e.g. "Finish the game") keep their notes sealed across streams.

**Stretch (only if time remains):** free-text conditions compiled by astra into the condition spec above, with a
validator; fall back to the list when that fails.

## 7. Moderation (streamer-managed, separate from categories)

**Pipeline**, in order:
1. local rules (length, URLs, a blocklist, the existing name/chat filter);
2. the Decisions verdict;
3. the broadcaster's mode.

**The broadcaster's config sets:**
- **Mode:** auto, auto + human queue for "unsure", or all-human.
- **Unsure handling:** hold, or reject.
- **Strictness:** lenient / standard / strict.
- **Extra forbidden topics** (checkboxes): spoilers, backseating, other creators, politics, plus custom words.
- **Limits:** max notes per viewer per stream; allow anonymous yes/no.

**A fixed floor that the streamer cannot loosen:** harassment, hate, sexual content, personal data, self-harm,
threats. The streamer can only make moderation stricter.

**Decisions question 1, moderation:** choices `safe | violates | unsure`. The instructions are built from the floor
plus the streamer's extra topics and strictness. Only `safe` passes automatically.

**The human queue** lives in the console. Approve/reject; rejection refunds where applicable.

## 8. Categories (streamer-managed) and other Decisions uses

**Each category has:**
- `name`;
- `envelope_color`, picked from a preset palette with tested contrast on stream;
- `subtitle` (e.g. Prediction → "I called it");
- `icon`, so colour is never the only cue;
- `description`, which becomes the Decisions choice description;
- an optional per-category price.

Use 3–6 categories. The defaults:
- **Advice**, subtitle "Listen to chat";
- **Prediction**, subtitle "I called it";
- **Joke**, subtitle "Don't take it personally";
- **Encouragement**, subtitle "You've got this".

**Who decides the category** (broadcaster setting):
- viewer only;
- AI only;
- viewer, then AI check; on mismatch, use the AI's category or hold for the streamer.

**Decisions question 2, classification.** The choices are generated from the live category list. It is sent **in
the same request** as question 1, so one round-trip covers both. The two answers stay independent: a classification
"unsure" never rejects a note.

**Other Decisions questions:**

| Question | Choices | When |
|---|---|---|
| Fits moment? | `fits / mismatched / unsure` | At sealing. A mismatch prompts the viewer to re-pick; it never auto-rejects. |
| Which note to open | ≤10 candidate note ids, with the moment context | At reveal, when more notes wait than N |
| Prediction verdict | `came_true / missed / unclear` | After reveal, for the prediction category |
| Frame watcher | e.g. `death_screen / victory_screen / boss_defeated / menu_or_loading / gameplay / unsure` | Every ~2 s on the latest game frame. Two consecutive agreeing answers → a "confirm?" prompt in the console. |
| Speech watcher (stretch) | `blames_game / boast / laughing / other / unsure` | On local transcript chunks; same confirmation rule |

**Verified Decisions request shape** (2026-10-29):
```
POST https://api.openai.com/v1/decisions
{ "model": "gpt-6-luna",
  "input": [{ "role": "user", "content": "<context>" }],          // images per docs, if used
  "questions": [{ "type": "choice", "instructions": "<question>",
                  "choices": [{ "value": "safe", "description": "..." }, ...] }, ...] }
→ { "answers": [{ "choice": "...", "probabilities": [...], "confidence": 0.0–1.0 }, ...] }
```
- `instructions` is required. A per-question `id` is **rejected**.

**Measured latency:** warm calls take 91–240 ms (mean about 160 ms); a cold call took about 1 s; one call once took
111 s.

**Transport rules:**
- one keep-alive HTTPS agent, warmed at startup;
- a hard deadline (sealing 1500 ms, frame watcher 800 ms);
- at most 8 calls in flight;
- per-viewer coalescing.

**Fallbacks:** rules plus hold for moderation; the viewer's own choice for the category; no AI moments.

**Tests mock the endpoint; never call it from tests.** Live probes are allowed only when the maintainer asks.

## 9. Payments (simulated) — streamer-configurable

**Config:**
- Free tier: on/off, and how many free notes per viewer per stream.
- Simulated Channel Points: on/off; price, global or per category; refund on reject / expire / never-opened (each a
  toggle).
- Simulated Bits: on/off; choose from fixed tiers 50 / 100 / 200 / 500, mirroring real Bits SKUs, which are fixed
  products.

**Perks** (configurable; defaults below):
- A paid note is **guaranteed**: it is opened when its moment happens and is never dropped by selection.
- The Bits tier gets a "gold seal" card style and may use long-lived or composite moments.

**Simulation:**
- Each viewer gets a simulated wallet (e.g. 10,000 points per stream, plus a "test Bits" balance), shown as TEST MODE.
- The transaction flow mirrors the real one: quote → moderation pass → charge → seal → refund rules.

**Real paths, implemented but off.** Behind `PAYMENTS_LIVE=false`; unit-tested with mocks.
- **Channel Points:**
  - Helix Create/Update Custom Reward ("Seal a note", no user input, so nothing private is ever posted to chat);
  - EventSub `channel.channel_points_custom_reward_redemption.add` grants a seal credit to the identity-linked viewer;
  - Update Redemption Status `FULFILLED` / `CANCELED` handles refunds.
- **Bits:**
  - `Twitch.ext.bits.useBits(sku)`, triggered only after moderation passes;
  - verify the `transactionReceipt` JWT with the extension secret before sealing.

## 10. Architecture

```
viewer panel / overlay (Twitch Extension, Hosted Test)
        │  HTTPS + extension JWT                 ▲ Extension PubSub (≤1 msg/s/channel; coalesced)
        ▼                                         │
relay nginx (new vhost) ──▶ local Node server (:8788)
                              ├─ EBS  /ebs/*  (JWT HS256, strict origin, rate limits, JSON schemas)
                              ├─ notes store + condition engine + selection
                              ├─ moderation/classification (Decisions client + rules)
                              ├─ payments (simulated | real, flagged)
                              ├─ Twitch: EventSub WS, Helix (broadcaster token, durable refresh)
                              ├─ perception: OBS source screenshots → Decisions frame watcher (optional)
                              ├─ /overlay   (OBS Browser Source, loopback; canonical reveal)
                              ├─ /console   (loopback-only operator page; cookie capability)
                              └─ /archive   (public read-only, through the relay)
```

**Reuse from `../wariostream`.** Copy each module and keep its tests; these are battle-tested.

| Module | What it gives you |
|---|---|
| `server/twitch-credentials.js` + auth journal | Durable token lifecycle: cross-process lock, atomic 0600 `.env` saves, proactive refresh, Device Code recovery (Phase 29) |
| `server/twitch.js`, `server/twitch-api.js` | EventSub WebSocket with reconnect/handoff; Helix client |
| `server/extension/{auth,service,publisher,identity}.js` | JWT verification, CORS/origin, rate limits, coalesced PubSub, identity-shared names (Phase 30) |
| `server/local-request.js` + the public route set pattern | Direct-loopback-only operator routes; forwarded traffic only reaches explicit public routes (Phase 31) |
| `server/decisions*.js` | Keep-alive transport, deadlines, admission/coalescing, rolling p50/p95 (Phase 28) |
| `pipeline/source-ring.js` | Optional: a single-OBS source-screenshot ring for the frame watcher (Phase 23) |
| `pipeline/mic-ring.js` | Optional: the speech watcher (stretch) |
| The chat/name filter | Used by moderation and names |

**Deployment.**
- A new relay vhost and subdomain; the maintainer creates DNS (an A record to the existing relay).
- Proxy only `/ebs/*`, the extension files and `/archive*` routes. **Never** proxy `/console`, `/overlay`, setup or
  WebSockets.
- Use the same NPS tunnel pattern as WarioStream, with a new port.

**A new Twitch extension registration** is needed, done by the maintainer or a Chrome-driving agent:
- Panel + Video – Fullscreen;
- Request Identity Link on;
- allowlist the new domain;
- Hosted Test only.

## 11. Security and privacy

- Sealed bodies are never sent to any client before reveal. Clients only receive ids, moment and status.
- Logs never contain note bodies before reveal, tokens or secrets. Fingerprints only.
- Anonymous viewers are never named.
- A chat action and an extension action by the same person are de-duplicated only after identity is shared.
- Public JSON (archive) projects only revealed notes and display-safe fields.

## 12. Testing and evidence

- **`npm test`** must be green. Mock Twitch, PubSub, Helix and Decisions. No real API calls in tests. Cover:
  - JWT accept/reject;
  - CORS;
  - rate limits;
  - moderation modes;
  - the category modes;
  - the paid-before-charge ordering;
  - refunds;
  - selection;
  - the prediction verdict;
  - conditions (count/window/never);
  - wrap-up;
  - the long-lived carry-over;
  - privacy: no body leaks before reveal.
- **A browser harness** mimicking the extension iframe and `Twitch.ext`. Screenshots at 1920×1080 and 640×360:
  - the panel compose screen;
  - TEST MODE prices;
  - the sealed receipt;
  - the overlay chip;
  - the private toast;
  - the OBS reveal for each category colour;
  - CALLED IT;
  - the never-opened reel;
  - the config page;
  - the console review queue.
- **A one-command demo** (`npm run demo`): fake viewers seal notes, scripted moments fire, reveals play on the
  overlay. No Twitch account is needed.

## 13. Plan (about 3 days)

1. **Day 1.**
   - Repo scaffold; copy the reused modules.
   - EBS + store.
   - Panel compose/seal.
   - Moderation and classification (Decisions + rules).
   - Config page for categories and moderation.
2. **Day 2.**
   - Moments: declared + Twitch + built-ins.
   - The condition engine.
   - Selection.
   - The OBS reveal.
   - The private toast.
   - Simulated payments, plus refunds.
   - The console queue.
   - Wrap-up.
3. **Day 3.**
   - Optional: the AI frame watcher (death/victory, with confirmation).
   - The archive.
   - The new extension registration + Hosted Test.
   - A live run on `wilf_lin`.
   - Polish.
   - Record the ≤3 min video: it shows Twitch running, and how Codex was used (development + Decisions at runtime).

**Out of scope:** real money; extension review/release; game integration; mobile-specific UI beyond what the panel
gives; free-text conditions (stretch).

## 14. Open questions for the maintainer

1. The project and extension name. "Sealed Notes" is a working title.
2. The subdomain for the relay, e.g. `notes.wilflin.me`.
3. Whether to keep the WarioStream extension installed during tests. Deactivate it to avoid two overlays.
