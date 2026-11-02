# Isolated NPS client provisioning

The Sealed Notes tunnel must use an independent NPS client. Reusing another running client's key can disconnect that client. This helper does not edit NPS databases, restart the broker, change old clients, or start a tunnel.

## Confirmed installed interface

The running broker's executable and cwd were reported as `/home/admin/npsc/nps` and `/home/admin/npsc`. Its active configuration is `/home/admin/npsc/conf/nps.conf`; the web listener uses port 6180. The web username and password remain private and are read only by the privileged remote process.

The publicly readable installed templates establish these endpoints and form fields:

- `web/views/login/index.html:174`: RSA PKCS#1 v1.5 encrypts a JSON payload with the login nonce, server timestamp and password. It POSTs to `/login/verify`. `/auth/gettime` supplies the server clock. Optional proof of work and login delay come from the rendered page.
- `web/views/client/list.html:60`: POST `/client/list` uses a URL-encoded table query.
- `web/views/client/add.html:100`: `config_conn_allow=1` enables configuration connections. The form includes `remark`, `vkey` and `max_tunnel`, and submits to `/client/add` at line 137.
- `web/views/index/list.html:45`: the tunnel table uses `/index/gettunnel`. The provisioning helper instead reads the active task database for an unfiltered reservation check; it never edits that database.

These source paths are on the relay under `/home/admin/npsc`. A rendered endpoint can still require additional interaction. Unsupported login pages, CAPTCHA, excessive proof-of-work settings, incomplete client lists and protocol changes fail closed. The helper does not guess alternative endpoints.

## Inspect first

```sh
python3 tools/provision-nps.py --inspect-api
```

Run this command in a terminal. Enter the sudo password through the private prompt. The helper uses a fixed SSH destination and fixed remote script. The password travels through stdin to `sudo -k -S`; it is absent from arguments, environment and files. The helper does not print raw stderr, API bodies, cookies, passwords or client keys.

The remote process reads the active web credentials into memory. It connects only to `http://127.0.0.1:6180`, disables proxy-environment handling, and rejects redirects outside that exact loopback origin. A cookie jar stays in process memory. OpenSSL encrypts the login payload using a public-key memory descriptor, without a temporary key or password file.

The public-key reader normalizes bounded JavaScript escape sequences without evaluating the page. It accepts only public-key PEM markers and valid base64. On an explicit API inspection, encryption diagnostics contain only byte counts, RSA bit count, format booleans and a fixed error category. The report never contains PEM bodies, login HTML, password payloads or OpenSSL stderr.

The report includes HTTP statuses, numeric client IDs, fixed schema field names, the number of active tasks, and reservation/listener booleans for port 18788. Other client remarks and credential values are omitted. Login can create an admin session; inspection makes no client or tunnel configuration change.

## Create only after review

Store a newly generated independent `NPS_VKEY` in this project's `.env`. Keep the file owned by the current user, mode 0600, gitignored and untracked. The helper rejects symlinks. Do not copy a running client's key.

After reviewing the sanitized inspection result, run:

```sh
python3 tools/provision-nps.py --create-client
```

The local helper reads only `NPS_VKEY` from the project file. It sends that value as a JSON payload through the same private SSH stdin stream, after the sudo password. No credential appears in a command argument or environment variable.

Before creating anything, the helper:

1. Loads the complete authenticated client list.
2. Checks for an existing client with the exact remark `sealed-notes`.
3. Rejects an existing client whose key or policy differs.
4. Rejects a key used by another client.
5. Checks all records in the active task database for port 18788.
6. Checks the listening sockets for port 18788.

The only configuration mutation is POST `/client/add` with remark `sealed-notes`, the supplied independent key, `max_tunnel=1`, and `config_conn_allow=1`. It creates no client web login and no basic-auth credentials. The installed form has no per-client port-allowlist field; no unconfirmed field is sent. The launcher separately requires relay binding `127.0.0.1:18788` and target `127.0.0.1:8788`.

The helper refetches the client list and verifies the new ID, remark, key match and policy. It compares existing clients' credential/configuration fields in memory and reports only whether those fields stayed unchanged. An identical existing client returns `status=existing` without a mutation. A mismatched existing client fails; it is never overwritten or deleted.

If a request fails after submission, the report marks the mutation outcome unconfirmed. Run inspection before deciding the next action. Do not retry with a different key or delete a client speculatively. This tool provides no delete, edit, broker-restart or database-write operation.

Local tests cover transport privacy, creation scope, idempotency, key collision, occupied-port rejection, private `.env` reading and the installed login form. A local OpenSSL test uses generated synthetic key material in memory to verify escaped PEM normalization and oversized-payload classification. Those tests do not establish a successful live admin login or client creation. Run the deliberate commands separately for that evidence.
