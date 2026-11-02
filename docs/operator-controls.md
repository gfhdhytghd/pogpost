# Operator quick controls

The top of `/console` contains **Quick controls**, before connection status and the main desk. It uses the existing Material Design 3 theme and responsive layout.

| Control | Behavior |
| --- | --- |
| Start detection / Stop detection | Start or stop picture capture and Decisions checks. The server supplies the actual state. |
| Reset observations | Clear evidence and pending suggestions. Detection keeps its current on/off state. Cooldowns and retry history remain. |
| Start recording / Stop recording | Enable or disable Debug capture records. Does not start detection or delete retained history. |
| Game profile / Change profile | Show the active profile and navigate to its selector. Preview and Apply remain required before switching. |
| Open debug page | Open the private image/request inspector. |
| Open OBS overlay | Open the reveal surface for OBS. |

These controls do not start or stop a Twitch broadcast. Wrap-up and new-session controls remain in their original locations.

Both switches disable during a pending request and refresh from the server afterward. A failed action shows an error and does not assume the requested state succeeded. Unavailable controls show the server's availability rather than an operative toggle.

The backend adds only the private state projection `integrations.debug: {available, enabled}`. Actions remain `perception_set`, `debug_set`, and `reset_perception` through the existing authenticated direct-loopback operator endpoint. No public control route was added.

Backend checks: `npm test` passed 383 tests, including diagnostic state synchronization, recording independent of detection, authority/origin rejection and unavailable diagnostics. All automated mutation tests use mocks.

A read-only browser check of the actual service found the top panel visible, picture detection off, Debug recording on and profile Kerbal Space Program. No control button was clicked during that check; no live capture or Twitch broadcast was started. Screenshot: `shots/operator-controls-live.png`.

`npm run test:operator-controls-browser` passed 28 checks on local mocked HTTP, covering top placement, detection and Debug action payloads, pending/error states, availability and external state synchronization, profile navigation without implicit Apply, narrow layout, and no external requests. Screenshots: `shots/operator-controls.png`, `shots/operator-controls-narrow.png`.
