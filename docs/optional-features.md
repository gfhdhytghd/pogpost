# Optional feature configuration

All optional provider flags are off by default. Tests use injected services. An enabled setting is not evidence of live acceptance.

## Twitch signals

Set `TWITCH_CONNECT=true` and `TWITCH_SIGNALS=true` only for an intentional runtime session with the new app's broadcaster authorization. The detector queries Helix for the actual live stream ID and start time. No verified live stream means no automatic duration, Clip or chat trigger. An offline fence rejects delayed old online events and responses. A genuinely later stream can recover through Helix.

In config, add a timer moment with `kind: "twitch"` and `trigger: {"type":"stream_minutes","minutes":15}`. The first observation at or after the milestone declares it once, with an event ID containing the live stream and moment IDs. It does not backdate note reveals.

Clip polling runs no faster than every 30 seconds while verified live. The first result is a baseline. It stores bounded IDs, not titles, URLs or media. Each query reads at most 100 Clips; Twitch sorts them by views, so high-volume streams can have missed Clips. This is best-effort observation, not exhaustive delivery.

Chat spikes use configurable message, distinct viewer, time-window and cooldown thresholds. Only authenticated EventSub events enter the detector. It stores bounded timestamps and IDs, not message bodies or names. The operator's `!moment` command still requires Twitch moderator/broadcaster badges.

## OBS frame proposals

Picture events now use [the generic event system](events.md). Import `presets/ksp.json` through `EVENTS_PRESET_FILE` for the six KSP events; `presets/generic.json` carries the original three events. See [KSP rehearsal](ksp-live-test.md). Persistent/instant rules are defined by event data, not separate game-specific watcher code.

Set `OBS_FRAME_WATCHER=true`, `DECISIONS_LIVE=true`, `OBS_SOURCE_NAME`, and optionally `OBS_WS_URL`/`OBS_PASSWORD` in `.env`. Only literal loopback destinations are accepted. The reader requests a PNG screenshot of one source at most once every two seconds. It never starts recording or broadcasting, changes scenes or controls the game.

The definition mode selects persistent negative/positive baselines or instant-window recognition. Matching evidence proposes a moment. The operator must press Confirm moment; Dismiss only removes the prompt. Prompts expire after 60 seconds and never carry image data.

## Local transcript proposals

Set `SPEECH_WATCHER=true`, `DECISIONS_LIVE=true` and `SPEECH_TRANSCRIPT_FILE=data/transcripts/stream.jsonl`. The private `data/transcripts` directory must have mode 0700; the regular JSONL file must have mode 0600. Symlinks and paths outside that directory are rejected.

An independently configured local transcription process can append complete records:

```json
{"at":"2026-10-30T04:00:00Z","text":"A fresh local transcript chunk."}
```

Use the current timestamp. Only complete records from the latest 15 seconds are consumed. Duplicate chunks do not count twice; two different agreeing chunks are required. Prompts contain only a label and moment ID. This module does not capture microphone audio or run speech recognition.

## Condition matching

Set `ASTRA_CONDITIONS=true` only for intentional runtime generation. The installed Codex CLI must have a working ChatGPT login and access to the configured model/tier. The compiler fixes `gpt-6-astra`, `service_tier=ultrafast` and reasoning effort `low`. It uses an isolated temporary directory, a minimal environment without API keys, disabled user configuration/tools/apps, a JSON schema and a five-second deadline.

The server validates the known moment ID and exact typed condition again. The viewer reviews the matched moment and condition in the form. Matching never seals a note, spends currency or declares a moment. Invalid, unavailable, ambiguous or late results return to the listed moments.

The local tests verify command arguments and environment isolation with a fake runner. Actual model availability, live latency and tool-disable enforcement remain unverified.
