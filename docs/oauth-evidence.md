# Broadcaster authorization evidence

On 2026-10-30, the maintainer explicitly approved both read-only permissions for the new Sealed Notes app. The official Twitch consent page identified `Sealed Notes` and `wilf_lin`. Twitch Connections then showed Sealed Notes as connected.

The local authorization flow validated the broadcaster before saving tokens. The verified user, owner and broadcaster ID is `1594736759`. Saved scopes are exactly `moderator:read:followers user:read:chat`. The app/client IDs match. Access and refresh tokens are present in the ignored `.env`, mode 0600; values are never printed or included in artifacts.

The safe screenshot `shots/twitch-authorized.png` shows the local terminal success state with no activation code or token.

The temporary authorization process on 8789 was stopped. `sealed-notes.service` was restarted to load credentials; both application and isolated NPC services are active. `npm run doctor -- --local --network --origin https://notes.wilflin.me` reports `ready=true`, all checks pass, and no provider calls. An unauthenticated public `/ebs/state` request now returns 403 rather than the pre-configuration 503.

`TWITCH_CONNECT`, `DECISIONS_LIVE` and `PAYMENTS_LIVE` remain false. OAuth consent does not establish EventSub/PubSub delivery, iframe acceptance, OBS behavior, live judgements, or viewer latency. No broadcast was started. No extension was submitted for review or released.
