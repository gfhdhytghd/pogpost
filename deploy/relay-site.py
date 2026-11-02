#!/usr/bin/env python3
"""Isolated root helper for notes.wilflin.me (Python standard library only).

Run inspect (the default), acme, certificate, https, verify, rollback in order.
Upload this file and nginx.conf.example together, then invoke with sudo. Never
pass a password as an argument. certificate reuses an existing Let's Encrypt
account; --account accepts its hexadecimal public directory ID. Multiple accounts
require an explicit selection. No account registration or TOS agreement occurs.
https requires a live listener bound only to loopback on port 18788. Verification
uses the system TLS trust store. Rollback restores only this site's initial file
and symlink; issued certificates and the dedicated ACME webroot remain intact.
All command output is captured, never printed. JSON contains fixed public status
labels only. Filesystem root/runner injection exists only in the Python API for
isolated tests, never as command-line flags. No broker/tunnel calls are made.
"""
import argparse
import contextlib
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import ssl
import stat
import subprocess
import tempfile

HOST = 'notes.wilflin.me'
PORT = 18788
MARKER = '# Managed by sealed-notes relay-site.py; notes.wilflin.me only\n'
SITE = '/etc/nginx/sites-available/notes.wilflin.me'
LINK = '/etc/nginx/sites-enabled/notes.wilflin.me'
STATE = '/var/lib/sealed-notes-relay-site'
WEBROOT = '/var/www/sealed-notes-acme'
CERT = '/etc/letsencrypt/live/notes.wilflin.me'
ACCOUNTS = '/etc/letsencrypt/accounts/acme-v02.api.letsencrypt.org/directory'
# This exact public allowlist is also pinned in the project's example template.
TEMPLATE = '''server {
    listen 443 ssl;
    server_name NOTES_DOMAIN;
    ssl_certificate /etc/letsencrypt/live/NOTES_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/NOTES_DOMAIN/privkey.pem;
    client_max_body_size 32k;
    location ~ ^/(ebs/(state|quote|notes|config|events|compile)|archive|api/archive|panel\\.html|video_overlay\\.html|config\\.html|client-config\\.js|styles\\.css|fraunces\\.woff2|fraunces-italic\\.woff2|instrument-sans\\.woff2|caveat\\.woff2|common\\.js|panel\\.js|config\\.js|video_overlay\\.js|archive\\.js)$ {
        proxy_pass http://127.0.0.1:NEW_NPS_RELAY_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade "";
        proxy_set_header Connection "";
        proxy_read_timeout 5s;
    }
    location / { return 404; }
}
'''


class Blocked(Exception):
    """Fixed, non-sensitive reason code."""


def run_command(args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=180,
                              check=False, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin',
                                                'LC_ALL': 'C'})
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked('command_unavailable') from None


def normalize_template(text):
    return ' '.join(re.sub(r'(?m)#.*$', '', text).split())


def render_https(template):
    if normalize_template(template) != normalize_template(TEMPLATE):
        raise Blocked('template_not_allowlisted')
    return template.replace('NOTES_DOMAIN', HOST).replace('NEW_NPS_RELAY_PORT', str(PORT))


def http_block(redirect=False):
    fallback = 'return 308 https://' + HOST + '$request_uri;' if redirect else 'return 404;'
    return '''server {
    listen 80;
    server_name ''' + HOST + ''';
    location ^~ /.well-known/acme-challenge/ {
        root ''' + WEBROOT + ''';
        default_type text/plain;
        try_files $uri =404;
    }
    location / { ''' + fallback + ''' }
}
'''


class RelaySite:
    def __init__(self, root=Path('/'), runner=run_command, uid=os.geteuid,
                 connector=socket.create_connection):
        self.root = Path(root)
        self.runner = runner
        self.uid = uid
        self.connector = connector

    def path(self, value):
        return self.root / value.lstrip('/')

    def secure_parents(self, path):
        for parent in [path, *path.parents]:
            if parent == self.root.parent:
                break
            if parent.is_symlink():
                raise Blocked('unsafe_path')
            if parent == self.root:
                break

    def command(self, args, reason):
        result = self.runner(args)
        if result.returncode:
            raise Blocked(reason)
        return result.stdout

    def snapshot(self):
        target, link = self.path(SITE), self.path(LINK)
        self.secure_parents(target.parent)
        self.secure_parents(link.parent)
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise Blocked('unmanaged_site')
        body = target.read_text() if target.exists() else None
        if body is not None and not body.startswith(MARKER):
            raise Blocked('unmanaged_site')
        if link.is_symlink():
            destination = os.readlink(link)
            if destination != SITE:
                raise Blocked('unmanaged_link')
        elif link.exists():
            raise Blocked('unmanaged_link')
        else:
            destination = None
        metadata = target.stat() if target.exists() else None
        return {'body': body, 'link': destination,
                'mode': stat.S_IMODE(metadata.st_mode) if metadata else 0o644,
                'uid': metadata.st_uid if metadata else 0,
                'gid': metadata.st_gid if metadata else 0}

    @staticmethod
    def fingerprint(snapshot):
        return hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()

    def atomic(self, path, body, mode=0o600, owner=None):
        self.secure_parents(path.parent)
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
            temp = Path(stream.name)
            try:
                os.fchmod(stream.fileno(), mode)
                if owner is not None:
                    os.fchown(stream.fileno(), *owner)
                stream.write(body.encode())
                stream.flush()
                os.fsync(stream.fileno())
                os.replace(temp, path)
            finally:
                temp.unlink(missing_ok=True)

    @contextlib.contextmanager
    def lock(self):
        if self.uid() != 0:
            raise Blocked('root_required')
        directory = self.path(STATE)
        self.secure_parents(directory)
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = directory.stat()
        if info.st_uid != self.uid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise Blocked('unsafe_state_directory')
        lockfile = directory / 'lock'
        if lockfile.is_symlink():
            raise Blocked('unsafe_state_directory')
        descriptor = os.open(lockfile, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            yield

    def state(self, create=False):
        file = self.path(STATE) / 'state.json'
        if file.is_symlink():
            raise Blocked('unsafe_state_directory')
        if file.exists():
            info = file.stat()
            if info.st_uid != self.uid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise Blocked('unsafe_state_directory')
            value = json.loads(file.read_text())
            if value.get('version') != 1 or value.get('host') != HOST:
                raise Blocked('invalid_state')
            return value
        if not create:
            raise Blocked('acme_phase_required')
        original = self.snapshot()
        value = {'version': 1, 'host': HOST, 'original': original,
                 'expected': [self.fingerprint(original)]}
        self.save(value)
        return value

    def save(self, value):
        self.atomic(self.path(STATE) / 'state.json', json.dumps(value, sort_keys=True))

    def check_expected(self, state):
        snapshot = self.snapshot()
        if self.fingerprint(snapshot) not in state['expected']:
            raise Blocked('concurrent_site_change')
        return snapshot

    def install_snapshot(self, snapshot):
        target, link = self.path(SITE), self.path(LINK)
        if snapshot['body'] is None:
            target.unlink(missing_ok=True)
        else:
            self.atomic(target, snapshot['body'], snapshot['mode'],
                        (snapshot['uid'], snapshot['gid']))
        if snapshot['link'] is None:
            link.unlink(missing_ok=True)
        elif not link.is_symlink():
            os.symlink(SITE, link)

    def nginx_test(self):
        self.command(['/usr/sbin/nginx', '-t'], 'nginx_validation_failed')

    def reload(self):
        self.command(['/usr/bin/systemctl', 'reload', 'nginx'], 'nginx_reload_failed')

    def require_snapshot(self, desired):
        if self.fingerprint(self.snapshot()) != self.fingerprint(desired):
            raise Blocked('site_write_not_persisted')

    def apply(self, desired, state):
        before = self.check_expected(state)
        # Record both crash recovery states before changing only this vhost.
        state['expected'] = [self.fingerprint(before), self.fingerprint(desired),
                             self.fingerprint({**desired, 'link': before['link']})]
        self.save(state)
        try:
            self.install_snapshot(desired)
            self.require_snapshot(desired)
            self.nginx_test()
            self.reload()
            self.nginx_test()
            self.require_snapshot(desired)
        except Exception:
            # Never overwrite an edit made after our write.
            self.check_expected(state)
            self.install_snapshot(before)
            state['expected'] = [self.fingerprint(before)]
            self.save(state)
            self.nginx_test()
            self.reload()
            raise Blocked('site_apply_failed_restored') from None
        state['expected'] = [self.fingerprint(desired)]
        self.save(state)
        self.require_snapshot(desired)

    def account_ids(self):
        directory = self.path(ACCOUNTS)
        self.secure_parents(directory)
        if not directory.exists():
            return []
        return sorted(child.name for child in directory.iterdir()
                      if not child.is_symlink() and child.is_dir()
                      and re.fullmatch(r'[0-9a-f]{32,64}', child.name)
                      and (child / 'regr.json').is_file()
                      and (child / 'private_key.json').is_file())

    def certificate_valid(self):
        fullchain, key = self.path(CERT + '/fullchain.pem'), self.path(CERT + '/privkey.pem')
        if not fullchain.is_file() or not key.is_file():
            raise Blocked('certificate_missing')
        cert = str(fullchain)
        self.command(['/usr/bin/openssl', 'x509', '-in', cert, '-noout', '-checkend', '3600'],
                     'certificate_expired')
        sans = self.command(['/usr/bin/openssl', 'x509', '-in', cert, '-noout', '-ext', 'subjectAltName'],
                            'certificate_invalid')
        if HOST not in re.findall(r'DNS:([^,\s]+)', sans):
            raise Blocked('certificate_hostname_mismatch')
        cert_key = self.command(['/usr/bin/openssl', 'x509', '-in', cert, '-pubkey', '-noout'],
                                'certificate_invalid')
        private_public = self.command(['/usr/bin/openssl', 'pkey', '-in', str(key), '-pubout'],
                                      'certificate_key_invalid')
        if not cert_key or cert_key != private_public:
            raise Blocked('certificate_key_mismatch')

    def loopback_ready(self):
        output = self.command(['/usr/bin/ss', '-H', '-ltn'], 'listener_check_failed')
        addresses = []
        for line in output.splitlines():
            fields = line.split()
            if len(fields) >= 4 and fields[3].rsplit(':', 1)[-1] == str(PORT):
                addresses.append(fields[3])
        if not addresses or any(value not in ('127.0.0.1:' + str(PORT), '[::1]:' + str(PORT),
                                               '::1:' + str(PORT)) for value in addresses):
            raise Blocked('loopback_listener_required')
        if '127.0.0.1:' + str(PORT) not in addresses:
            raise Blocked('loopback_listener_required')
        try:
            with self.connector(('127.0.0.1', PORT), timeout=3):
                pass
        except OSError:
            raise Blocked('relay_unavailable') from None

    def inspect(self):
        snapshot = self.snapshot()
        return {'site': 'managed' if snapshot['body'] is not None else 'absent',
                'enabled': snapshot['link'] is not None,
                'accountIds': self.account_ids(),
                'certificatePresent': self.path(CERT + '/fullchain.pem').is_file(),
                'rollbackPresent': (self.path(STATE) / 'state.json').is_file()}

    def acme(self):
        self.nginx_test()
        state = self.state(create=True)
        self.check_expected(state)
        self.secure_parents(self.path(WEBROOT))
        self.path(WEBROOT).mkdir(mode=0o755, parents=True, exist_ok=True)
        desired = {'body': MARKER + http_block(), 'link': SITE, 'mode': 0o644, 'uid': self.uid(), 'gid': os.getegid()}
        self.apply(desired, state)
        return {'configuration': 'acme_http_only'}

    def certificate(self, account=None):
        state = self.state()
        current = self.check_expected(state)
        if current['body'] != MARKER + http_block() or current['link'] != SITE:
            raise Blocked('acme_phase_required')
        self.nginx_test()
        accounts = self.account_ids()
        if account is not None and not re.fullmatch(r'[0-9a-f]{32,64}', account):
            raise Blocked('invalid_account_id')
        if account is None:
            if len(accounts) != 1:
                raise Blocked('existing_account_selection_required')
            account = accounts[0]
        if account not in accounts:
            raise Blocked('existing_account_required')
        self.command(['/usr/bin/certbot', 'certonly', '--webroot', '-w', WEBROOT,
                      '--server', 'https://acme-v02.api.letsencrypt.org/directory',
                      '-d', HOST, '--cert-name', HOST, '--non-interactive',
                      '--account', account], 'certificate_request_failed')
        self.certificate_valid()
        return {'certificate': 'valid_for_host'}

    def https(self, template, recover_acme=False):
        self.nginx_test()
        state = self.state()
        if recover_acme:
            # Explicit recovery is limited to the exact configuration emitted by acme.
            expected_acme = {'body': MARKER + http_block(), 'link': SITE,
                             'mode': 0o644, 'uid': self.uid(), 'gid': os.getegid()}
            if self.fingerprint(self.snapshot()) != self.fingerprint(expected_acme):
                raise Blocked('acme_recovery_not_exact')
            recovered = self.fingerprint(expected_acme)
            state['recoveredAcmeFingerprint'] = recovered
            state['expected'] = [recovered]
            self.save(state)
        self.check_expected(state)
        self.certificate_valid()
        self.loopback_ready()
        desired = {'body': MARKER + http_block(True) + render_https(template),
                   'link': SITE, 'mode': 0o644, 'uid': self.uid(), 'gid': os.getegid()}
        self.apply(desired, state)
        return {'configuration': 'https_public_allowlist'}

    def verify(self):
        self.nginx_test()
        self.certificate_valid()
        self.loopback_ready()
        state = self.state()
        current = self.check_expected(state)
        if 'listen 443 ssl;' not in (current['body'] or ''):
            raise Blocked('https_phase_required')
        # Fixed domain, system CA verification and SNI. Never follow redirects.
        paths = [('/archive', {200}), ('/api/archive', {200}),
                 ('/operator', {404}), ('/operator/state', {404}),
                 ('/overlay', {404}), ('/setup', {404}), ('/ws', {404}),
                 ('/health', {404}), ('/.env', {404})]
        for path, accepted in paths:
            connection = http.client.HTTPSConnection(HOST, timeout=10,
                                                      context=ssl.create_default_context())
            try:
                connection.request('GET', path)
                response = connection.getresponse()
                if response.status not in accepted:
                    raise Blocked('https_route_check_failed')
            except (OSError, http.client.HTTPException):
                raise Blocked('https_connection_failed') from None
            finally:
                connection.close()
        return {'tls': 'system_trust_verified', 'routes': 'public_and_private_checked'}

    def rollback(self):
        state = self.state()
        self.check_expected(state)
        self.apply(state['original'], state)
        return {'configuration': 'initial_site_restored', 'certificates': 'retained'}


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        print(json.dumps({'status': 'blocked', 'reason': 'invalid_arguments'}, sort_keys=True))
        raise SystemExit(2)


def main(argv=None):
    parser = SafeParser(description=__doc__)
    parser.add_argument('--phase', choices=['inspect', 'acme', 'certificate', 'https', 'verify', 'rollback'],
                        default='inspect')
    parser.add_argument('--account')
    parser.add_argument('--recover-acme', action='store_true',
                        help='Explicitly recover only the exact managed ACME configuration before HTTPS')
    parser.add_argument('--template', type=Path, default=Path(__file__).resolve().with_name('nginx.conf.example'))
    args = parser.parse_args(argv)
    helper = RelaySite()
    try:
        if args.recover_acme and args.phase != 'https':
            raise Blocked('invalid_arguments')
        if args.phase == 'inspect':
            result = helper.inspect()
        else:
            with helper.lock():
                if args.phase == 'certificate':
                    result = helper.certificate(args.account)
                elif args.phase == 'https':
                    template = args.template
                    if not template.is_absolute() or template.is_symlink() or not template.is_file():
                        raise Blocked('unsafe_template_path')
                    helper.secure_parents(template.parent)
                    if template.stat().st_mode & 0o022:
                        raise Blocked('unsafe_template_path')
                    result = helper.https(template.read_text(), recover_acme=args.recover_acme)
                else:
                    result = getattr(helper, args.phase)()
        print(json.dumps({'status': 'ok', 'phase': args.phase, 'host': HOST, **result}, sort_keys=True))
        return 0
    except Blocked as error:
        print(json.dumps({'status': 'blocked', 'phase': args.phase, 'reason': str(error)}, sort_keys=True))
        return 2
    except Exception:
        print(json.dumps({'status': 'blocked', 'phase': args.phase, 'reason': 'operation_failed'}, sort_keys=True))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
