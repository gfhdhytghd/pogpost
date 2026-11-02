import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const project = path.resolve(import.meta.dirname, '..');
// All mutations stay inside TemporaryDirectory. No commands or sockets run.
const python = String.raw`
import contextlib, importlib.util, json, os, pathlib, subprocess, sys, tempfile, unittest
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('relay_site', 'deploy/relay-site.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.commands = []
        self.fail_validation_once = False
        self.listener = 'LISTEN 0 128 127.0.0.1:18788 0.0.0.0:*\n'
        self.helper = m.RelaySite(pathlib.Path(self.temp.name), runner=self.runner,
                                  connector=lambda *a, **kw: contextlib.nullcontext())
        for directory in ('/etc/nginx/sites-available', '/etc/nginx/sites-enabled', m.STATE):
            self.helper.path(directory).mkdir(parents=True, mode=0o700)
        self.template = pathlib.Path('deploy/nginx.conf.example').read_text()

    def runner(self, args):
        self.commands.append(args)
        output, code = '', 0
        if args[:2] == ['/usr/bin/ss', '-H']:
            output = self.listener
        if '-checkend' in args:
            output = 'Certificate will not expire\n'
        if 'subjectAltName' in args:
            output = 'X509v3 Subject Alternative Name:\n DNS:' + m.HOST
        if '-pubkey' in args or '-pubout' in args:
            output = 'PUBLIC KEY FIXTURE\n'
        if args == ['/usr/sbin/nginx', '-t'] and self.fail_validation_once:
            self.fail_validation_once = False
            code = 1
        return subprocess.CompletedProcess(args, code, output, 'SECRET_SENTINEL')

    def certificate_files(self):
        directory = self.helper.path(m.CERT)
        directory.mkdir(parents=True)
        (directory / 'fullchain.pem').write_text('PUBLIC CERT FIXTURE')
        (directory / 'privkey.pem').write_text('PRIVATE KEY SENTINEL')

    def account(self, name='a'*32):
        directory = self.helper.path(m.ACCOUNTS) / name
        directory.mkdir(parents=True)
        for file in ('regr.json', 'private_key.json'):
            (directory / file).write_text('SECRET_SENTINEL')
        return name

    def test_inspect_is_read_only_and_secret_free(self):
        self.account()
        self.certificate_files()
        result = self.helper.inspect()
        self.assertEqual(result['site'], 'absent')
        self.assertEqual(self.commands, [])
        self.assertNotIn('SENTINEL', json.dumps(result))
        self.assertFalse((self.helper.path(m.STATE) / 'state.json').exists())

    def test_acme_then_https_then_rollback_only_target(self):
        unrelated = self.helper.path('/etc/nginx/sites-available/old-app')
        unrelated.write_text('KEEP')
        self.helper.acme()
        config = self.helper.path(m.SITE).read_text()
        self.assertIn('listen 80;', config)
        self.assertIn('location / { return 404; }', config)
        self.assertNotIn('proxy_pass', config)
        self.certificate_files()
        self.helper.https(self.template)
        config = self.helper.path(m.SITE).read_text()
        self.assertIn('127.0.0.1:18788', config)
        self.assertIn('return 308 https://notes.wilflin.me$request_uri;', config)
        for private in ('operator', 'location /overlay', 'location /setup', 'location /ws'):
            self.assertNotIn(private, config)
        self.helper.rollback()
        self.assertFalse(self.helper.path(m.SITE).exists())
        self.assertFalse(self.helper.path(m.LINK).is_symlink())
        self.assertTrue(self.helper.path(m.CERT + '/privkey.pem').exists())
        self.assertEqual(unrelated.read_text(), 'KEEP')
        self.assertEqual(os.stat(self.helper.path(m.STATE) / 'state.json').st_mode & 0o777, 0o600)

    def test_unmanaged_site_and_link_refused(self):
        target = self.helper.path(m.SITE)
        target.write_text('UNMANAGED')
        with self.assertRaisesRegex(m.Blocked, 'unmanaged_site'):
            self.helper.acme()
        self.assertEqual(target.read_text(), 'UNMANAGED')
        target.unlink()
        os.symlink('/etc/nginx/sites-available/old-app', self.helper.path(m.LINK))
        with self.assertRaisesRegex(m.Blocked, 'unmanaged_link'):
            self.helper.acme()

    def test_managed_original_preserved_and_concurrent_edit_refused(self):
        target = self.helper.path(m.SITE)
        original = m.MARKER + 'previous managed contents\n'
        target.write_text(original)
        self.helper.acme()
        target.write_text(m.MARKER + 'CONCURRENT\n')
        with self.assertRaisesRegex(m.Blocked, 'concurrent_site_change'):
            self.helper.rollback()
        self.assertIn('CONCURRENT', target.read_text())
        state = self.helper.state()
        target.write_text(m.MARKER + m.http_block())
        self.helper.rollback()
        self.assertEqual(target.read_text(), original)
        self.assertFalse(self.helper.path(m.LINK).is_symlink())

    def test_validation_failure_restores_before_reload(self):
        self.helper.acme()
        before = self.helper.path(m.SITE).read_text()
        self.certificate_files()
        original_install = self.helper.install_snapshot
        def install(snapshot):
            original_install(snapshot)
            if 'listen 443' in (snapshot['body'] or ''):
                self.fail_validation_once = True
        self.helper.install_snapshot = install
        before_commands = len(self.commands)
        with self.assertRaisesRegex(m.Blocked, 'site_apply_failed_restored'):
            self.helper.https(self.template)
        self.assertEqual(self.helper.path(m.SITE).read_text(), before)
        # Failed candidate never reloads; only restored config is reloaded.
        reloads = [a for a in self.commands[before_commands:] if 'reload' in a]
        self.assertEqual(len(reloads), 1)

    def test_certificate_only_reuses_selected_existing_account(self):
        self.helper.acme()
        first = self.account()
        self.certificate_files()
        self.helper.certificate()
        command = next(a for a in self.commands if a[0] == '/usr/bin/certbot')
        self.assertIn(first, command)
        self.assertIn('--non-interactive', command)
        self.assertNotIn('--agree-tos', command)
        self.assertNotIn('--register-unsafely-without-email', command)
        second = self.account('b'*32)
        with self.assertRaisesRegex(m.Blocked, 'existing_account_selection_required'):
            self.helper.certificate()
        self.helper.certificate(second)
        with self.assertRaisesRegex(m.Blocked, 'invalid_account_id'):
            self.helper.certificate('a;touch /tmp/pwn')

    def test_https_requires_certificate_and_exclusively_loopback_listener(self):
        self.helper.acme()
        before = self.helper.path(m.SITE).read_text()
        with self.assertRaisesRegex(m.Blocked, 'certificate_missing'):
            self.helper.https(self.template)
        self.certificate_files()
        for listener in ('', 'LISTEN 0 128 0.0.0.0:18788 0.0.0.0:*\n',
                         'LISTEN 0 128 [::]:18788 [::]:*\n'):
            self.listener = listener
            with self.assertRaisesRegex(m.Blocked, 'loopback_listener_required'):
                self.helper.https(self.template)
        self.assertEqual(self.helper.path(m.SITE).read_text(), before)

    def test_template_rejects_configuration_injection(self):
        m.render_https(self.template)
        for template in (self.template + '\ninclude /tmp/evil;\n',
                         self.template.replace('location / { return 404; }', 'location / { proxy_pass http://evil; }'),
                         self.template.replace('notes|config', 'notes|operator|config')):
            with self.assertRaisesRegex(m.Blocked, 'template_not_allowlisted'):
                m.render_https(template)

    def test_certificate_san_and_key_mismatch_refused(self):
        self.certificate_files()
        runner = self.helper.runner
        def wrong_san(args):
            result = runner(args)
            if 'subjectAltName' in args:
                result.stdout = 'DNS:other.wilflin.me'
            return result
        self.helper.runner = wrong_san
        with self.assertRaisesRegex(m.Blocked, 'certificate_hostname_mismatch'):
            self.helper.certificate_valid()
        def wrong_key(args):
            result = runner(args)
            if '-pubout' in args:
                result.stdout = 'DIFFERENT PUBLIC KEY'
            return result
        self.helper.runner = wrong_key
        with self.assertRaisesRegex(m.Blocked, 'certificate_key_mismatch'):
            self.helper.certificate_valid()

    def test_verify_uses_system_tls_and_checks_private_paths(self):
        self.helper.acme()
        self.certificate_files()
        self.helper.https(self.template)
        requests, contexts = [], []
        original = m.http.client.HTTPSConnection
        class Connection:
            def __init__(self, host, timeout, context):
                self.assert_host = host
                contexts.append(context)
            def request(self, method, path):
                requests.append(path)
                self.path = path
            def getresponse(self):
                return type('Response', (), {'status': 200 if self.path in ('/archive', '/api/archive') else 404})()
            def close(self):
                pass
        m.http.client.HTTPSConnection = Connection
        try:
            self.helper.verify()
        finally:
            m.http.client.HTTPSConnection = original
        self.assertIn('/operator/state', requests)
        self.assertIn('/ws', requests)
        self.assertTrue(all(context.check_hostname and context.verify_mode == m.ssl.CERT_REQUIRED for context in contexts))

    def test_persisted_snapshot_required_and_exact_acme_recovery(self):
        self.helper.acme()
        acme = self.helper.snapshot()
        self.certificate_files()
        self.helper.https(self.template)
        # Model an external writer restoring the exact earlier managed ACME file.
        self.helper.install_snapshot(acme)
        with self.assertRaisesRegex(m.Blocked, 'concurrent_site_change'):
            self.helper.https(self.template)
        self.helper.https(self.template, recover_acme=True)
        self.assertEqual(self.helper.state()['recoveredAcmeFingerprint'], self.helper.fingerprint(acme))
        self.helper.path(m.SITE).write_text(m.MARKER + 'UNKNOWN WRITER\n')
        with self.assertRaisesRegex(m.Blocked, 'acme_recovery_not_exact'):
            self.helper.https(self.template, recover_acme=True)
        self.assertIn('UNKNOWN WRITER', self.helper.path(m.SITE).read_text())

    def test_noop_writer_and_post_state_restore_are_detected(self):
        self.helper.acme()
        acme = self.helper.snapshot()
        self.certificate_files()
        install = self.helper.install_snapshot
        self.helper.install_snapshot = lambda snapshot: None
        with self.assertRaisesRegex(m.Blocked, 'site_apply_failed_restored'):
            self.helper.https(self.template)
        self.helper.install_snapshot = install
        save = self.helper.save
        def save_then_external_restore(state):
            save(state)
            desired = self.helper.snapshot()
            if 'listen 443 ssl;' in (desired['body'] or '') and len(state['expected']) == 1:
                install(acme)
        self.helper.save = save_then_external_restore
        with self.assertRaisesRegex(m.Blocked, 'site_write_not_persisted'):
            self.helper.https(self.template)
        self.assertEqual(self.helper.snapshot(), acme)

    def test_root_gate_and_symlink_state_directory(self):
        with self.assertRaisesRegex(m.Blocked, 'root_required'):
            with m.RelaySite(self.helper.root, uid=lambda: 1000).lock():
                pass
        state = self.helper.path(m.STATE)
        state.rmdir()
        os.symlink('/tmp', state)
        with self.assertRaisesRegex(m.Blocked, 'unsafe_path'):
            self.helper.state(create=True)

unittest.main(verbosity=1)
`;

test('relay site helper: isolated Python phase, rollback and security tests', () => {
  const output = execFileSync('python3', ['-c', python], { cwd: project, encoding: 'utf8', stdio: 'pipe' });
  assert.doesNotMatch(output, /SECRET_SENTINEL|PRIVATE KEY SENTINEL/);
});

test('relay helper CLI defaults to inspect and redacts invalid argument values', () => {
  const script = path.join(project, 'deploy/relay-site.py');
  const output = JSON.parse(execFileSync('python3', [script], { encoding: 'utf8', stdio: 'pipe' }));
  assert.equal(output.phase, 'inspect');
  assert.equal(output.host, 'notes.wilflin.me');
  assert.throws(() => execFileSync('python3', [script, '--unknown', 'SECRET_SENTINEL'], { encoding: 'utf8', stdio: 'pipe' }), error => {
    assert.equal(error.status, 2);
    assert.equal(JSON.parse(error.stdout).reason, 'invalid_arguments');
    assert.doesNotMatch(error.stdout + error.stderr, /SECRET_SENTINEL/);
    return true;
  });
});
