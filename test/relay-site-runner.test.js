import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const project = path.resolve(import.meta.dirname, '..');
const python = String.raw`
import importlib.util, json, subprocess, sys, unittest
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('runner', 'tools/run-relay-site.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Tests(unittest.TestCase):
    def test_password_only_in_stdin_and_fixed_remote_command(self):
        calls = []
        account = 'a'*32
        def runner(command, **options):
            calls.append((command, options))
            return subprocess.CompletedProcess(command, 0, json.dumps({
                'status': 'ok', 'phase': 'certificate', 'host': m.HOST,
                'certificate': 'valid_for_host'}), 'SECRET_SENTINEL')
        result = m.execute('certificate', account, 'PASSWORD_SENTINEL', runner)
        command, options = calls[0]
        self.assertEqual(result['status'], 'ok')
        self.assertNotIn('PASSWORD_SENTINEL', repr(command))
        self.assertEqual(options.pop('input'), 'PASSWORD_SENTINEL\n')
        self.assertNotIn('PASSWORD_SENTINEL', repr(options))
        self.assertNotIn('env', options)
        self.assertEqual(options['timeout'], 240)
        self.assertNotIn('shell', options)
        self.assertEqual(command[:2], ['ssh', '-T'])
        self.assertEqual(command[-2], 'admin@wilflin.me')
        self.assertEqual(command[-1], "sudo -S -p '' /usr/bin/python3 /home/admin/sealed-notes-relay-staging/relay-site.py --phase certificate --account " + account)

    def test_phase_account_and_password_injection_refused(self):
        for phase in ('acme; id', '--phase https', '', 'ssh'):
            with self.assertRaises(m.Blocked):
                m.arguments(phase)
        for account in ('abc;id', 'A'*32, 'a'*31, 'a'*65, 'a'*32+'\n'):
            with self.assertRaises(m.Blocked):
                m.arguments('certificate', account)
        with self.assertRaises(m.Blocked):
            m.arguments('https', 'a'*32)
        for password in ('', 'pw\ncommand', 'pw\r', 'pw\0'):
            with self.assertRaises(m.Blocked):
                m.execute('acme', None, password, lambda *a, **k: self.fail('runner called'))

    def test_explicit_recovery_flag_is_https_only(self):
        self.assertTrue(m.arguments('https', recover_acme=True)[-1].endswith('--recover-acme'))
        with self.assertRaises(m.Blocked):
            m.arguments('acme', recover_acme=True)

    def test_https_template_path_is_fixed_and_other_timeouts_short(self):
        self.assertTrue(m.arguments('https')[-1].endswith('--template /home/admin/sealed-notes-relay-staging/nginx.conf.example'))
        def runner(command, **options):
            self.assertEqual(options['timeout'], 40)
            return subprocess.CompletedProcess(command, 0, json.dumps({
                'status': 'ok', 'phase': 'acme', 'host': m.HOST,
                'configuration': 'acme_http_only'}), '')
        m.execute('acme', None, 'PRIVATE', runner)

    def test_raw_error_and_unrecognized_response_never_escape(self):
        cases = [(255, 'PRIVATE_SENTINEL'), (0, 'PRIVATE_SENTINEL'),
                 (2, json.dumps({'status':'blocked','phase':'acme','reason':'PRIVATE_SENTINEL'})),
                 (0, json.dumps({'status':'ok','phase':'acme','host':m.HOST,'configuration':'PRIVATE_SENTINEL'})),
                 (0, json.dumps({'status':'ok','phase':'acme','host':m.HOST,'configuration':'acme_http_only','private':'PRIVATE_SENTINEL'}))]
        for code, stdout in cases:
            def runner(command, **options):
                return subprocess.CompletedProcess(command, code, stdout, 'PASSWORD_SENTINEL')
            with self.assertRaises(m.Blocked) as result:
                m.execute('acme', None, 'PRIVATE', runner)
            self.assertNotIn('SENTINEL', str(result.exception))

    def test_timeout_and_missing_ssh_are_fixed_status(self):
        def timeout(*a, **kw):
            raise subprocess.TimeoutExpired('PRIVATE_SENTINEL', 40, output='PRIVATE_SENTINEL')
        def unavailable(*a, **kw):
            raise OSError('PRIVATE_SENTINEL')
        for runner, reason in ((timeout, 'remote_timeout'), (unavailable, 'ssh_unavailable')):
            with self.assertRaisesRegex(m.Blocked, reason):
                m.execute('acme', None, 'PRIVATE', runner)

    def test_valid_block_and_inspect_are_schema_checked(self):
        blocked = {'status':'blocked','phase':'https','reason':'loopback_listener_required'}
        self.assertEqual(m.validate_response(json.dumps(blocked), 'https', 2), blocked)
        report = {'status':'ok','phase':'inspect','host':m.HOST,'site':'absent','enabled':False,
                  'accountIds':['a'*32],'certificatePresent':False,'rollbackPresent':False}
        self.assertEqual(m.validate_response(json.dumps(report), 'inspect', 0), report)
        report['accountIds'] = ['PRIVATE_SENTINEL']
        with self.assertRaises(m.Blocked):
            m.validate_response(json.dumps(report), 'inspect', 0)

unittest.main(verbosity=1)
`;

test('relay site runner: mocked SSH, stdin secrecy and fixed output schema', () => {
  const output = execFileSync('python3', ['-c', python], { cwd: project, encoding: 'utf8', stdio: 'pipe' });
  assert.doesNotMatch(output, /SENTINEL/);
});

test('relay site runner requires explicit phase and interactive TTY', () => {
  const file = path.join(project, 'tools/run-relay-site.py');
  for (const args of [[], ['--phase', 'acme'], ['--phase', 'acme;SECRET_SENTINEL']]) {
    assert.throws(() => execFileSync('python3', [file, ...args], { encoding: 'utf8', stdio: 'pipe' }), error => {
      assert.equal(error.status, 2);
      const output = JSON.parse(error.stdout);
      assert.equal(output.status, 'blocked');
      assert.doesNotMatch(error.stdout + error.stderr, /SECRET_SENTINEL/);
      return true;
    });
  }
});
