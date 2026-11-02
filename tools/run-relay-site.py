#!/usr/bin/env python3
"""Run one explicitly selected relay-site phase through SSH and sudo.

Usage: python3 tools/run-relay-site.py --phase acme
Certificate example: --phase certificate --account <existing public account ID>
Requires an interactive TTY. Enter the sudo password only at the private prompt.
Upload the reviewed public helper and template separately before running this
wrapper. This wrapper never copies files or runs subsequent phases. Certificate
issuance reuses an existing account; it does not register or accept new TOS.
"""
import argparse
import getpass
import json
import re
import subprocess
import sys
import warnings

HOST = 'notes.wilflin.me'
REMOTE = 'admin@wilflin.me'
DIRECTORY = '/home/admin/sealed-notes-relay-staging'
PHASES = ('inspect', 'acme', 'certificate', 'https', 'verify', 'rollback')
REASONS = frozenset('''command_unavailable template_not_allowlisted unsafe_path
unmanaged_site unmanaged_link root_required unsafe_state_directory invalid_state
acme_phase_required concurrent_site_change nginx_validation_failed
nginx_reload_failed site_apply_failed_restored certificate_missing
certificate_expired certificate_invalid certificate_hostname_mismatch
certificate_key_invalid certificate_key_mismatch listener_check_failed
loopback_listener_required relay_unavailable invalid_account_id
existing_account_selection_required existing_account_required
certificate_request_failed https_phase_required https_route_check_failed
https_connection_failed unsafe_template_path operation_failed invalid_arguments
site_write_not_persisted acme_recovery_not_exact'''.split())


class Blocked(Exception):
    """Fixed public status code."""


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        print(json.dumps({'status': 'blocked', 'reason': 'invalid_arguments'}, sort_keys=True))
        raise SystemExit(2)


def arguments(phase, account=None, recover_acme=False):
    if phase not in PHASES:
        raise Blocked('invalid_phase')
    if account is not None and (phase != 'certificate' or
                                not re.fullmatch(r'[0-9a-f]{32,64}', account)):
        raise Blocked('invalid_account_id')
    if type(recover_acme) is not bool or (recover_acme and phase != 'https'):
        raise Blocked('invalid_arguments')
    remote = ['sudo', '-S', '-p', "''", '/usr/bin/python3',
              DIRECTORY + '/relay-site.py', '--phase', phase]
    if account is not None:
        remote.extend(['--account', account])
    if phase == 'https':
        remote.extend(['--template', DIRECTORY + '/nginx.conf.example'])
    if recover_acme:
        remote.append('--recover-acme')
    # Every token is fixed or validated against an exact phase/hex allowlist.
    return ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
            REMOTE, ' '.join(remote)]


def validate_response(raw, phase, returncode):
    try:
        if len(raw) > 16384:
            raise ValueError()
        value = json.loads(raw)
        if not isinstance(value, dict) or value.get('phase') != phase:
            raise ValueError()
        if value.get('status') == 'blocked':
            if returncode != 2 or set(value) != {'status', 'phase', 'reason'} or value['reason'] not in REASONS:
                raise ValueError()
            return {'status': 'blocked', 'phase': phase, 'reason': value['reason']}
        if returncode != 0 or value.get('status') != 'ok' or value.get('host') != HOST:
            raise ValueError()
        base = {'status', 'phase', 'host'}
        if phase == 'inspect':
            if set(value) != base | {'site', 'enabled', 'accountIds', 'certificatePresent', 'rollbackPresent'}:
                raise ValueError()
            if value['site'] not in ('managed', 'absent'):
                raise ValueError()
            if any(type(value[key]) is not bool for key in ('enabled', 'certificatePresent', 'rollbackPresent')):
                raise ValueError()
            if not isinstance(value['accountIds'], list) or len(value['accountIds']) > 64:
                raise ValueError()
            if any(not isinstance(item, str) or not re.fullmatch(r'[0-9a-f]{32,64}', item)
                   for item in value['accountIds']):
                raise ValueError()
        else:
            expected = {
                'acme': {'configuration': 'acme_http_only'},
                'certificate': {'certificate': 'valid_for_host'},
                'https': {'configuration': 'https_public_allowlist'},
                'verify': {'tls': 'system_trust_verified', 'routes': 'public_and_private_checked'},
                'rollback': {'configuration': 'initial_site_restored', 'certificates': 'retained'},
            }[phase]
            if set(value) != base | set(expected) or any(value[key] != result for key, result in expected.items()):
                raise ValueError()
        return value
    except (ValueError, TypeError, KeyError):
        raise Blocked('remote_response_invalid') from None


def execute(phase, account, password, runner=subprocess.run, recover_acme=False):
    command = arguments(phase, account, recover_acme)
    if not isinstance(password, str) or not password or '\n' in password or '\r' in password or '\0' in password:
        raise Blocked('invalid_private_input')
    try:
        result = runner(command, input=password + '\n', capture_output=True, text=True,
                        timeout=240 if phase == 'certificate' else 40, check=False)
    except subprocess.TimeoutExpired:
        raise Blocked('remote_timeout') from None
    except OSError:
        raise Blocked('ssh_unavailable') from None
    if result.returncode not in (0, 2):
        raise Blocked('remote_execution_failed')
    return validate_response(result.stdout, phase, result.returncode)


def main(argv=None):
    parser = SafeParser(description=__doc__)
    parser.add_argument('--phase', required=True, choices=PHASES)
    parser.add_argument('--account')
    parser.add_argument('--recover-acme', action='store_true')
    args = parser.parse_args(argv)
    try:
        arguments(args.phase, args.account, args.recover_acme)
        if not sys.stdin.isatty() or not sys.stderr.isatty():
            raise Blocked('interactive_tty_required')
        # Refuse getpass's fallback when terminal echo cannot be disabled.
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            password = getpass.getpass('Relay sudo password: ')
        try:
            result = execute(args.phase, args.account, password, recover_acme=args.recover_acme)
        finally:
            password = None
        print(json.dumps(result, sort_keys=True))
        return 0 if result['status'] == 'ok' else 2
    except (EOFError, KeyboardInterrupt):
        print(json.dumps({'status': 'blocked', 'phase': args.phase, 'reason': 'private_input_cancelled'}, sort_keys=True))
        return 2
    except Blocked as error:
        print(json.dumps({'status': 'blocked', 'phase': args.phase, 'reason': str(error)}, sort_keys=True))
        return 2
    except Exception:
        print(json.dumps({'status': 'blocked', 'phase': args.phase, 'reason': 'operation_failed'}, sort_keys=True))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
