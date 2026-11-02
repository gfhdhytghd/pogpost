# Public deployment evidence

Verification date: **2026-10-30**. Public route verification timestamp: **19:17:51 UTC**.

This records independent, read-only HTTP/TLS checks of `https://notes.wilflin.me`, plus service and listener inspection. It supersedes the earlier failed public TLS check in this session. No certificate verification was bypassed. No redirects were followed. No provider API, broadcast, service mutation, or credential-file read was performed.

## TLS

Ordinary curl returned:

```text
remote_ip=47.90.217.99
http_code=200
ssl_verify_result=0
url=https://notes.wilflin.me/archive
```

The public certificate returned with SNI `notes.wilflin.me` was:

```text
subject=CN=notes.wilflin.me
issuer=C=US, O=Let's Encrypt, CN=YE2
notBefore=Oct 30 18:02:05 2026 GMT
notAfter=Jan 28 18:02:04 2027 GMT
X509v3 Subject Alternative Name:
    DNS:notes.wilflin.me
```

Each of the 11 Node HTTPS requests below reported `socket.authorized === true` and remote address `47.90.217.99`.

## Public route results

Requests used GET without an Authorization header, operator cookie, or forwarded header. Response bodies were discarded except for the two fixed EBS error projections.

| Route | HTTP status | Content type | Result |
| --- | --- | --- | --- |
| `/archive` | 200 | `text/html; charset=utf-8` | Public archive page reachable |
| `/api/archive` | 200 | `application/json; charset=utf-8` | Public archive API reachable |
| `/panel.html` | 200 | `text/html; charset=utf-8` | Public extension page reachable |
| `/common.js` | 200 | `text/javascript; charset=utf-8` | Public extension module reachable |
| `/console` | 404 | `text/html` | Private route unavailable publicly |
| `/overlay` | 404 | `text/html` | Private route unavailable publicly |
| `/setup` | 404 | `text/html` | Private route unavailable publicly |
| `/api/operator/bootstrap` | 404 | `text/html` | Private route unavailable publicly |
| `/api/operator/state` | 404 | `text/html` | Private route unavailable publicly |
| `/ebs/state` | 503 | `application/json; charset=utf-8` | Unconfigured EBS fails closed |
| `/ebs/config` | 503 | `application/json; charset=utf-8` | Unconfigured EBS fails closed |

Both EBS responses had `ok: false` and `error: "extension_not_configured"`. Only these fixed fields were retained as evidence. This establishes safe rejection while the extension is unconfigured. It does not establish configured JWT acceptance or rejection, identity consent, or Hosted Test acceptance.

## Application and tunnel evidence

Follow-up read-only inspection in the same verification run returned:

| Check | Observed result |
| --- | --- |
| Local `sealed-notes.service` | `ActiveState=active`, `SubState=running`, `MainPID=940516` |
| Local `sealed-notes-npc.service` | `ActiveState=active`, `SubState=running`, `MainPID=940517` |
| Local application socket | `127.0.0.1:8788`, LISTEN |
| Relay socket inspected through `admin@wilflin.me` | `127.0.0.1:18788`, LISTEN |

An earlier read-only check during the preceding verification attempt also fetched `http://127.0.0.1:18788/api/archive` from the relay and returned HTTP 200. The successful public HTTPS archive request above verifies the current public route through the deployed stack. Neither listener inspection nor HTTP reachability proves Twitch or OpenAI acceptance.

## Reproduction commands

```sh
curl --silent --show-error --max-time 10 --output /dev/null \
  --write-out 'remote_ip=%{remote_ip}\nhttp_code=%{http_code}\nssl_verify_result=%{ssl_verify_result}\nurl=%{url_effective}\n' \
  https://notes.wilflin.me/archive

openssl s_client -connect notes.wilflin.me:443 -servername notes.wilflin.me </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -ext subjectAltName

systemctl --user show sealed-notes.service sealed-notes-npc.service \
  -p Id -p ActiveState -p SubState -p MainPID

ss -ltn '( sport = :8788 )'

ssh -o BatchMode=yes -o ConnectTimeout=10 admin@wilflin.me \
  'ss -ltn "( sport = :18788 )"'
```

The 11-route check used Node's default HTTPS trust and hostname verification:

```js
import https from 'node:https';

const routes = [
  '/archive', '/api/archive', '/panel.html', '/common.js', '/console',
  '/overlay', '/setup', '/api/operator/bootstrap', '/api/operator/state',
  '/ebs/state', '/ebs/config',
];

for (const route of routes) {
  await new Promise(resolve => {
    const request = https.get('https://notes.wilflin.me' + route, { timeout: 5000 }, response => {
      console.log({
        route,
        status: response.statusCode,
        contentType: response.headers['content-type'],
        remoteAddress: response.socket.remoteAddress,
        authorized: response.socket.authorized,
      });
      response.destroy();
      resolve();
    });
    request.on('error', error => { console.log({ route, error: error.code }); resolve(); });
    request.on('timeout', () => request.destroy());
  });
}
```

## Unverified acceptance

- Configured extension JWT behavior on this public deployment.
- Twitch Hosted Test rendering and identity sharing.
- Live Decisions calls and live perception.
- OBS presentation, viewer latency, and a real broadcast.
