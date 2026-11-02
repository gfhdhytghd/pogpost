# Privileged relay inspection

`tools/relay-admin.py` currently supports only read-only inspection. It does not deploy a vhost, obtain a certificate, modify NPS databases, start a tunnel, reload nginx, or restart any service. Existing relay sites and tunnels remain outside its mutation scope.

Run the helper deliberately from a terminal:

```sh
python3 tools/relay-admin.py --inspect
```

The helper asks for the sudo password once with `getpass`. SSH connects to the fixed destination `admin@wilflin.me`. The password travels only through SSH stdin to `sudo -S`; it is absent from command arguments, files, and environment variables. The remote Python script is fixed source code. The helper does not print remote stderr, raw exceptions, or the password. It clears its password references in `finally`; Python does not guarantee immediate zeroing of string memory.

SSH connection timeout is 10 seconds. The local operation timeout is 30 seconds. Failures return a generic JSON reason and a nonzero exit status. Never put a password in a shell command, a script, an argument, or an environment variable.

The JSON report contains only these selected observations:

- NPS public bridge/web settings and allowed-port syntax. Web username/password and authentication values appear only as presence booleans. Active configuration candidates come only from each running NPS process's cwd (`conf/nps.conf` or `nps.conf`); `/etc/nps/conf` is reported separately and does not establish the active installation.
- NPS JSON database format, record counts, known schema field names, unknown-field counts, and numeric client IDs. Credential values, remarks, dynamic map keys, and note contents are omitted.
- Running NPS executable/cwd paths, PID, parent PID and parent command name. Process arguments and environment are omitted.
- Matching service-unit names and selected state fields. Service environment and command lines are omitted.
- Certbot account identifiers and count. The two existing `twitchapi.wilflin.me` and `wilflin.me` renewal files contribute only validated account identifiers and recognized Let's Encrypt production/staging directory URLs. Account key contents are omitted.
- New notes-site file presence, narrowly selected public nginx directives, directory write access, and the exit status of `nginx -t`. The command output is omitted.
- Listening addresses for port 18788. An absent listener does not establish a free broker reservation.

A successful inspection establishes neither deployment nor Hosted Test acceptance. Inspect the sanitized result before designing a new NPS client or applying any changes. Use a distinct client key for a concurrent Sealed Notes tunnel. Never reuse a running client's key or restart the broker to add this application.

The broader rollout and rollback boundaries remain in [deployment-readiness.md](deployment-readiness.md) and [relay-inspection.md](relay-inspection.md). No privileged mutation command is implemented by this helper.
