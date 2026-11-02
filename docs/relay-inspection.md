# Relay inspection — 2026-10-30

This document preserves the initial read-only inspection on 2026-10-30. Its historical observations predate the later authorized deployment work described in the current-status section below. The initial inspection used SSH as `admin@wilflin.me` and public DNS/HTTP/TLS checks. That inspection changed no remote file, certificate, service, tunnel, DNS record, or nginx configuration. It sent no Twitch or OpenAI request and printed no credential value or private-key content.

## Current status — later checks on 2026-10-30

- Authorized sudo succeeded. The earlier noninteractive-sudo failure below is historical.
- The active NPS executable and cwd are `/home/admin/npsc/nps` and `/home/admin/npsc`; its configuration is `/home/admin/npsc/conf/nps.conf`. The `/etc/nps/conf` paths below did not establish the active installation.
- New independent NPS client ID 6 was created. The persistent application and NPC systemd services are active. The application listens on `127.0.0.1:8788`.
- The new relay upstream `127.0.0.1:18788/api/archive` returned HTTP 200. The existing port-18787 listener remains in place.
- A certificate covering `notes.wilflin.me` was issued successfully.
- Normal TLS verification and public `/archive` access now pass. Every local/network doctor check passes, including denied private routes. The relay helper's final verification returned `ok`, `system_trust_verified` and `public_and_private_checked`.
- An earlier HTTPS phase returned `ok`, but a subsequent check found the canonical ACME-only port-80 configuration and a deployment-state fingerprint mismatch. Its cause remains unconfirmed. The repaired helper verifies fingerprints after writing, reloading and saving state; recovery and final verification succeeded.
- Chrome is available. Real OAuth has reached the final two read-only permissions and waits for explicit user confirmation. A temporary authorization server remains on port 8789.
- The latest local test run passed all 179 tests, and the isolated authorization-browser suite passed all 19 checks. The doctor's only warning is `credentials:extension`; pending verified numeric IDs/OAuth completion leave `ready=false`. Twitch acceptance remains separate.

The following sections retain the original observations and proposed procedure. Their historical TLS, sudo and missing-client results are superseded by the current checks above. Do not replay their mutation steps as if they were outstanding work.

## Confirmed observations

| Check | Result | Scope |
| --- | --- | --- |
| SSH `admin@wilflin.me` with BatchMode | Successful; uid 1000, user `admin`, member of `sudo` | SSH authentication only |
| `sudo -n nginx -t` | Failed: `sudo: a password is required` | Noninteractive elevation is unavailable |
| nginx executable | `/usr/sbin/nginx` exists | Executable metadata only; syntax validation is blocked by elevation |
| Certbot executable | `/usr/bin/certbot`, symlink to `/opt/certbot/bin/certbot` | Installation metadata only |
| nginx directories | `/etc/nginx/sites-available`, `/etc/nginx/sites-enabled`, `/etc/nginx/conf.d` | Existing site layout |
| `notes.wilflin.me` DNS | IPv4 `47.90.217.99` | Resolver observation at inspection time |
| Random related hostname | `sealed-notes-probe-20261030.wilflin.me` also resolves to `47.90.217.99` | Supports a wildcard DNS inference; does not prove a dedicated notes record |
| `http://notes.wilflin.me` | HTTP 200 from `47.90.217.99` | Port 80 is reachable; this is not a Sealed Notes acceptance result |
| `https://notes.wilflin.me` | curl exit 60: certificate hostname mismatch | Ordinary hostname verification fails |
| Public certificate with SNI `notes.wilflin.me` | Subject `CN=ai.wilflin.com`; SAN only `DNS:ai.wilflin.com`; issuer Let's Encrypt YE1 | Does not cover `notes.wilflin.me` |
| Certificate validity dates | 2026-09-07 15:13:29 GMT to 2026-12-06 15:13:28 GMT | Public certificate metadata only |
| Ports 80 and 443 | IPv4 and IPv6 wildcard listeners | HTTP/TLS services are running |
| NPS broker port 8025 | Listening on `*:8025` | Listener presence only; authentication and transport were not probed |
| Existing relay tunnel | `127.0.0.1:18787` listening | Preserve this listener |
| Proposed port 18788 | No listening socket at inspection time | Not a reservation; broker configuration could still reserve it |

The public HTTPS certificate is consistent with an unmatched hostname reaching the existing default TLS virtual host. The source configuration is readable, but the loaded nginx configuration was not dumped with root permissions. Do not equate that inference with a verified loaded configuration.

## nginx and certificate paths

The readable enabled-site inventory contains no `server_name notes.wilflin.me`. No notes-named file appears in `sites-available` or `sites-enabled`. No notes-named renewal configuration appears in `/etc/letsencrypt/renewal`.

Existing relevant configuration:

- `/etc/nginx/sites-enabled/default` points to `/etc/nginx/sites-available/default`. It contains the default port-80 server and the existing `wilflin.me` configuration.
- `/etc/nginx/sites-enabled/ai.wilflin.com` points to `/etc/nginx/sites-available/ai.wilflin.com`. Its TLS certificate path is `/etc/letsencrypt/live/ai.wilflin.com/fullchain.pem`.
- `/etc/nginx/sites-enabled/twitchapi.wilflin.me` points to `/etc/nginx/sites-available/twitchapi.wilflin.me`. Its explicit routes proxy to `http://127.0.0.1:18787`. Its TLS certificate path is `/etc/letsencrypt/live/twitchapi.wilflin.me/fullchain.pem`.
- Existing nginx sites include `/etc/letsencrypt/options-ssl-nginx.conf` for shared TLS settings.
- `/etc/letsencrypt/live` is root-only. Its contents were not read.

Visible renewal configuration names are: `ai.wilflin.com`, `ai.wilflin.me`, `gitzilla.wilflin.me`, `gpt.wilflin.me`, `ollama.wilflin.com`, `perplexica.wilflin.com`, `repokaiju.wilflin.me`, `serv.wilflin.com`, `serv.wilflin.me`, `tharsis.wilflin.com`, `twitchapi.wilflin.me`, `wilflin.com`, `wilflin.me`, and `xx.wilflin.me`. These names alone do not establish each certificate's SAN coverage. The renewal file contents were not read.

Create the new site as `/etc/nginx/sites-available/notes.wilflin.me`, with a matching new symlink under `sites-enabled`. The intended new certificate paths are `/etc/letsencrypt/live/notes.wilflin.me/fullchain.pem` and `/etc/letsencrypt/live/notes.wilflin.me/privkey.pem`. They are proposed paths, not confirmed existing files.

## NPS boundary

The directory listing reveals these broker configuration paths:

- `/etc/nps/conf/nps.conf`
- `/etc/nps/conf/clients.json`
- `/etc/nps/conf/global.json`
- `/etc/nps/conf/hosts.json`

The `admin` account cannot read their contents or their individual metadata through the directory permissions. The inspection did not try alternate methods to read them. A process named `nps` was running as PID `4019206` during inspection. `systemctl show nps.service` reported `ActiveState=inactive`, `SubState=dead`, and an empty `FragmentPath`. This does not establish how the running broker is supervised. The `docker` command is unavailable. The process's cgroup text contained neither `docker` nor `containerd`; that does not establish its launcher.

The existing client pattern supplied for this project is `server_addr=wilflin.me:8025`, `conn_type=tls`, with an existing `[wariostream-web]` listener on `18787` targeting `127.0.0.1:8787`. The new application must use a distinct section and listener. Broker-side port permissions, reservations, loopback binding policy, and the accepted key for the new tunnel remain unverified. Do not edit the existing tunnel or copy its key into generated files.

## Safe minimum rollout

This is a proposed maintainer procedure. None of these mutation steps ran during inspection.

1. Establish an authorized elevated session. Re-run `/usr/sbin/nginx -t` with elevation. The current `sudo -n` route cannot do this.
2. Confirm port 18788 in the broker's reservation and permission configuration. Recheck listening sockets immediately before allocation. Confirm the broker's actual supervisor before any service operation.
3. Back up only configuration files changed for this new site. Preserve the existing nginx sites, the running broker, and listener 18787.
4. Add a new HTTP-only `notes.wilflin.me` site on IPv4/IPv6 port 80. Serve only `/.well-known/acme-challenge/` from a new dedicated directory such as `/var/www/sealed-notes-acme`. Return 404 for other paths during certificate setup. Do not reference missing certificate files yet.
5. Run elevated `nginx -t`. Reload nginx only after that check succeeds.
6. Obtain a new named certificate using the existing Certbot installation and a webroot challenge. For example: `sudo /usr/bin/certbot certonly --webroot --webroot-path /var/www/sealed-notes-acme --cert-name notes.wilflin.me -d notes.wilflin.me`. Confirm account and renewal settings deliberately. Do not use standalone mode while the existing port-80 server is running.
7. Review `dist/deploy/nginx.conf` against the actual new certificate paths and allocated relay port. Install only the new notes HTTPS block. Keep the port-80 challenge route for renewal. Other port-80 requests can redirect to the new HTTPS host after its certificate is valid.
8. Run elevated `nginx -t`. Reload nginx only after that check succeeds.
9. Provision the isolated NPC tunnel using a runtime-only private configuration. The new project `.env` remains the sole persistent secret source. A literal `${NPS_VKEY}` template is not runnable until a private runtime renderer supplies it.
10. Verify the new relay listener is loopback-only, `127.0.0.1:18788`, before exposing the new vhost. Preserve the existing listener. If the new listener binds publicly, stop only the new tunnel and resolve the binding policy.
11. Start the local application deliberately on `127.0.0.1:8788`. Keep `PAYMENTS_LIVE=false`. Enabling live-provider flags requires an intentional session.
12. Run `npm run doctor -- --local` and `npm run doctor -- --network --origin https://notes.wilflin.me`. Verify the correct certificate, public archive, and denied operator/OBS/bootstrap routes. Test Hosted Test separately with the new Twitch registration.

Rollback removes only the new notes site and stops only the new application/tunnel. Run `nginx -t` before each reload. Keep private application state and credentials intact.

## Reproduction commands

These commands do not print secret configuration:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 admin@wilflin.me id
ssh -o BatchMode=yes -o ConnectTimeout=10 admin@wilflin.me 'sudo -n nginx -t'
ssh -o BatchMode=yes -o ConnectTimeout=10 admin@wilflin.me 'ss -ltn "( sport = :80 or sport = :443 or sport = :8025 or sport = :18787 or sport = :18788 )"'
ssh -o BatchMode=yes -o ConnectTimeout=10 admin@wilflin.me 'systemctl show nps.service --property=FragmentPath --property=ActiveState --property=SubState --no-pager'
getent ahostsv4 notes.wilflin.me
getent ahostsv4 sealed-notes-probe-20261030.wilflin.me
curl --max-time 10 -sS -o /dev/null -w 'HTTP status=%{http_code} remote=%{remote_ip}\n' http://notes.wilflin.me
curl --max-time 10 -sS -o /dev/null -w 'HTTPS status=%{http_code} verify=%{ssl_verify_result}\n' https://notes.wilflin.me
openssl s_client -connect notes.wilflin.me:443 -servername notes.wilflin.me </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
```

The nginx source inspection emitted only selected public directives and paths: `listen`, `server_name`, certificate paths, `root`, `include`, `location`, safe local upstreams, and ordinary redirect/status returns. It did not dump complete files, authorization headers, certificate private-key contents, or request/response bodies.
