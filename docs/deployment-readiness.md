# Deployment readiness

The staging tools write files locally. They do not change DNS, install a service, start a tunnel, reload nginx, call OpenAI or Twitch, activate an extension, or start a broadcast. The separate `tools/nps-tunnel.mjs` command starts a tunnel only when an operator runs it deliberately. Payments remain simulated. The extension remains in Hosted Test.

## Readiness boundary

Local tests establish application behavior with mocks. They do not establish a working public relay, a valid Twitch registration, consent, a live video overlay, an OBS capture, or acceptance on `wilf_lin`.

The current deployment checks on 2026-10-30 establish these separate results:

- `notes.wilflin.me` resolved to `47.90.217.99`.
- SSH as `admin@wilflin.me` and authorized sudo succeeded.
- A new certificate covering `notes.wilflin.me` was issued successfully.
- Independent NPS client ID 6 was created with a distinct key.
- The persistent application on `127.0.0.1:8788` and its NPC systemd service are active.
- The relay listener `127.0.0.1:18788` returned HTTP 200 for `/api/archive`. The existing listener on port 18787 remains in place.
- Normal TLS verification and public `/archive` access pass.
- `npm run doctor -- --local --network --origin https://notes.wilflin.me` passes every local/network check, including denied private routes. After verified OAuth and numeric-ID setup, all checks pass and `ready=true`.
- The relay helper's final verification returned `ok`, `system_trust_verified` and `public_and_private_checked`.
- An earlier HTTPS phase returned `ok`, but a subsequent check found the canonical ACME-only port-80 configuration and a deployment-state fingerprint mismatch. The cause remains unconfirmed. The repaired helper checks fingerprints after writing, reloading and saving state; recovery and final verification succeeded.

The tested public TLS/archive and private-route boundaries pass. Twitch Hosted Test iframe/PubSub and live-stream acceptance remain pending. Preserve the existing sites and the existing tunnel. The latest `npm test` run passed all 179 tests, and the isolated authorization-browser suite passed all 19 checks. Mocked authorization-browser checks do not establish real consent.

## Local diagnosis

Run the offline check:

```sh
npm run doctor
```

The report checks Node.js 24+, installed dependencies, `flock`, GNU tar, `.env` mode 0600, Git exclusion, and simulated payments. Credentials appear only as presence booleans. The tool never prints credential values or raw parsing errors. Presence does not establish validity or registration ownership. Missing extension credentials produce a warning and a nonzero exit status.

Store credentials only in the project `.env`. The OpenAI key reuse was explicitly authorized. Twitch credentials must belong to the new registration. Keep `PAYMENTS_LIVE=false`. Keep live-provider flags false until an intentional maintainer-run session. The runtime reads `.env` itself; it is not a shell script or a systemd `EnvironmentFile`.

The new extension is registered in Hosted Test; see `hosted-test.md`. Its client ID and secret are saved privately. Real OAuth consent completed for `wilf_lin` with exactly `moderator:read:followers` and `user:read:chat`; verified owner/broadcaster/user ID is `1594736759`. Access and refresh tokens were saved privately. See `oauth-evidence.md`. `/setup` never pre-fills saved secrets, clears its password input, and keeps provider flags off. It is direct-loopback only and is not in the relay allowlist.

The persistent application currently owns port 8788. The temporary authorization server on port 8789 was stopped after successful consent. The persistent service was restarted to load the verified credentials. Do not start a demo or a second application on port 8788. Use a separate port such as 8790 for an offline demo. A source archive has no `.git`; initialize Git and verify `.env` is ignored before using its credential writer.

Check an already-running loopback application without starting it:

```sh
npm run doctor -- --local
```

This reads `/api/archive` at `127.0.0.1:8788` and checks that a forwarded request cannot read `/console`. It does not authorize Twitch, create an operator cookie, change notes, or start the server.

After the relay and certificate exist, explicitly opt into public checks:

```sh
npm run doctor -- --network --origin https://notes.wilflin.me
```

The tool checks public DNS, normal TLS trust and hostname verification, HTTP 200 on `/api/archive`, and denial of `/console`, `/overlay`, and `/api/operator/bootstrap`. It pins requests to the checked public DNS address. It rejects local/private destinations and redirects. It does not read response bodies or call provider APIs. These HTTP checks do not establish Twitch Hosted Test acceptance.

## Stage deployment files

Confirm a new relay listener port before applying anything. Stage the proposed configuration:

```sh
npm run deploy:prepare -- --origin https://notes.wilflin.me --relay-port 18788
```

The command writes these gitignored files:

- `dist/deploy/nginx.conf`: a new hostname and explicit public route allowlist.
- `dist/deploy/sealed-notes.service`: a user service with the exact local project path, the exact Node executable, private umask, and port 8788. The application binds to `127.0.0.1`.
- `dist/deploy/npc.conf.template`: a distinct `[sealed-notes-web]` TCP tunnel section, relay binding `127.0.0.1`, target `127.0.0.1:8788`, and the literal `${NPS_VKEY}` placeholder.

If the application directory or Node executable differs on the application host, pass `--workdir /absolute/project/path --node /absolute/path/to/node`. Paths containing whitespace or systemd substitutions are rejected.

The existing NPS transport pattern uses `server_addr=wilflin.me:8025` and `conn_type=tls`. A new listener port and section isolate this application. Confirm the relay's accepted configuration before applying it.

The NPC file is a review template. NPC does not expand `${NPS_VKEY}` itself. Store `NPS_VKEY` only in this project's gitignored, owned, regular `.env` with mode 0600. Do not render a secret-bearing configuration file. Do not use shell `source`, `eval`, command-line secrets, or environment variables for the NPC credential.

After the listener allocation and application are ready, start the isolated tunnel deliberately:

```sh
node tools/nps-tunnel.mjs
```

The launcher requires Linux, `/usr/bin/python3`, and `/usr/local/bin/npc`. It reads only this project's `.env` and rejects symlinks and tracked credentials. It pipes the configuration to `tools/nps-memfd.py`. The helper creates an anonymous Linux memory descriptor with mode 0600, writes the configuration into that descriptor, and replaces itself with NPC using `--config /proc/self/fd/NUMBER`. No named configuration file is created. The Node stdin pipe cannot be reopened as `/dev/stdin` by the installed NPC, so the memory descriptor supplies a readable configuration with a real size.

The helper disables NPC logging and debug output, discards child stdout/stderr, and gives NPC only a fixed `PATH`. The key is absent from child arguments and environment. The configuration stays in memory and the stdin pipe. SIGINT and SIGTERM terminate the child. Never reuse the running WarioStream client's NPS key for a concurrent client; obtain a distinct authorized client key before starting this tunnel.

The default ports are relay `18788` and application `8788`. Override them only with `NPS_RELAY_PORT` and `NPS_TARGET_PORT` in `.env`; both must be numeric ports from 1024 to 65535. The relay port must also differ from the protected existing listener and local application ports. The relay configuration includes `server_ip=127.0.0.1`; the application target also remains loopback. The transport uses `conn_type=tls` without disabling certificate checks. A started process does not establish broker acceptance or a working public route. Verify both listeners and the public doctor checks separately. The installed-NPC integration test uses a synthetic key and an ephemeral loopback peer; it proves memory-descriptor loading without contacting the actual broker.

## Manual apply and verification

1. Confirm DNS, relay access, certificate paths, and ownership of the new listener port.
2. Review all staged files. Confirm the new vhost has no generic proxy fallback. Only explicit EBS routes, extension assets, and archive routes are public.
3. Save a private backup of the existing relay configuration. Keep the existing vhost, certificate, and tunnel unchanged.
4. Install the new application user service on the application host. Keep `.env` private. Keep the project data directory private and outside all public routes.
5. Configure `NPS_VKEY` in this project's `.env`. Run `node tools/nps-tunnel.mjs` deliberately. Do not copy an old tunnel key into a template or a rendered file.
6. Install the new nginx file under a new site name. Confirm the certificate covers `notes.wilflin.me`. Run `nginx -t` before a maintainer reloads nginx.
7. Start the application service deliberately. Verify the Node listener is `127.0.0.1:8788`. Verify the new relay listener is `127.0.0.1:18788` and nginx points to that listener. Stop only the new tunnel if its listener binds publicly.
8. Run the local and public doctor checks. A successful public check requires normal certificate verification and denied operator routes.
9. Build `dist/extension.zip` with `npm run ext:zip -- https://notes.wilflin.me`. Upload only that archive to the new registration's Hosted Test version. Configure the new EBS allowlist, Panel, Video Fullscreen, and Request Identity Link.
10. Activate Hosted Test deliberately. The maintainer decides whether to deactivate the other video overlay. Never submit for review or release.
11. Complete the acceptance steps in `docs/acceptance.md`. The maintainer starts the broadcast. Verify the real panel, identity consent, private sealing, moderation, delayed notice, declared moment, OBS reveal, archive, and wrap-up before ending the stream.

The public archive is intentionally readable. Operator, OBS, bootstrap, demo, setup and WebSocket routes must remain inaccessible through the relay. The `/ebs/compile` route is public only as an authenticated, schema-validated extension operation; it is not an operator bypass.

## Rollback

1. Deactivate the new Hosted Test extension deliberately if its public endpoint is unavailable.
2. Stop only the Sealed Notes application service and its isolated tunnel.
3. Disable only the new nginx site. Run `nginx -t` before a maintainer reloads nginx.
4. Restore only files changed for this deployment from the private backup. Preserve the existing application, vhost and tunnel.
5. Keep `.env` and `data/notes.json` private. Do not delete notes, tokens, or another application's state.

## Source handoff

```sh
npm run bundle
cd dist
sha256sum -c source.tar.gz.sha256
```

`dist/source.tar.gz` contains an explicit source allowlist: project manifests, `.env.example`, `.gitignore`, README, SPEC, progress, and source files under `server`, `engine`, `public`, `tools`, `test`, `deploy`, `presets`, and `docs`. Source types are JavaScript, Python, JSON, Markdown, HTML, CSS, SVG, examples, and templates. The bundle excludes `.env`, `.env.*` except the root `.env.example`, `.git`, dependencies, data, runs, test data, private/secret/credential directories, symlinks, generated artifacts and screenshots. It never appends itself. `dist/source.tar.gz.sha256` records the archive digest.

The archive is a source handoff. Credentials, installed dependencies, private state, extension activation and public service acceptance remain separate.
