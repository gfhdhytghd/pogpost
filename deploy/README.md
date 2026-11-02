# Hosted Test deployment handoff

This directory contains templates only. No DNS, tunnel, relay, extension installation or broadcast is changed by the application.

Current state: the new extension registration, identity sharing, allowlists and static upload are complete in Hosted Test. See `../docs/hosted-test.md`; do not create a duplicate registration. The remaining steps below require the new relay certificate/access, broadcaster authorization and channel acceptance.

1. Choose a new subdomain and create its A record on the existing relay.
2. Register a NEW Twitch extension: Panel + Video Fullscreen, Request Identity Link enabled, the new EBS domain allowlisted, Hosted Test only. Do not submit it for review or release it.
3. Put only the new registration's credentials in `.env`, mode 0600. Do not reuse another extension's secret or registration.
4. Configure a new NPS tunnel for local port 8788 and a distinct relay listener port. Keep the local Node listener on 127.0.0.1.
5. Replace the placeholders in `nginx.conf.example`. Check nginx syntax and access boundaries before a maintainer reloads it. The relay must add forwarding headers, even though its upstream is loopback.
6. Set `PUBLIC_HOST` and `EBS_PUBLIC_URL`. Build the upload archive with `npm run ext:zip -- https://YOUR-NEW-DOMAIN`.
7. Upload the archive to Hosted Test, configure the EBS allowlist and identity linking, and activate the new extension deliberately. Decide whether to deactivate the other extension to avoid two overlays.
8. In OBS, add `http://127.0.0.1:8788/overlay` as a transparent 1920×1080 Browser Source. The maintainer starts the stream. Video overlays render only while live.
9. Open `/console` directly on the streamer PC. Test private submission, identity consent, moderation, latency-delayed private notices, declared moments and wrap-up. Press Wrap up before ending the broadcast.

`PAYMENTS_LIVE` stays false. Real Channel Points and Bits are unavailable on `wilf_lin`. Adapter unit tests with mocks do not establish real payment acceptance.

The operator, OBS overlay, bootstrap, demo, WebSocket and setup routes must never be forwarded. The public route set is `/ebs/*`, `/archive`, `/api/archive`, and the explicit extension assets listed in the nginx template.
