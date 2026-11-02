import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const helper = path.resolve(import.meta.dirname, '../tools/provision-nps.py');
const prelude = `
import importlib.util,json,sys,subprocess
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('provision_nps',${JSON.stringify(helper)})
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
remote={'__name__':'test_remote'};exec(module.REMOTE_SCRIPT,remote)
`;
function python(script) {
  return JSON.parse(execFileSync('/usr/bin/python3', ['-c', prelude + script], { encoding: 'utf8' }));
}

test('NPS admin transport keeps sudo password and client key only in private stdin', () => {
  assert.deepEqual(python(`
password='SYNTHETIC_SUDO_ONLY';key='SYNTHETIC_NEW_KEY_ONLY';captured={}
def fake(args,**kwargs):
    captured.update(args=args,**kwargs)
    return subprocess.CompletedProcess(args,0,'{"operation":"create-client","status":"created","clientId":6,"mutated":true}','')
report=module.remote_operation(password,{'operation':'create-client','vkey':key},runner=fake)
assert captured['input'].splitlines()[0]==password
assert json.loads(captured['input'].splitlines()[1])['vkey']==key
for secret in [password,key]:
    assert secret not in json.dumps(captured['args'])
    assert secret not in json.dumps(captured['env'])
    assert secret not in json.dumps(report)
assert 'sudo -k -S' in captured['args'][-1]
def failed(args,**kwargs): raise RuntimeError(password+key)
failure=module.remote_operation(password,{'operation':'create-client','vkey':key},runner=failed)
assert password not in json.dumps(failure) and key not in json.dumps(failure)
assert failure['mutationOutcome']=='unconfirmed'
print(json.dumps({'safe':True}))
`), { safe: true });
});

test('NPS new-client plan rejects duplicate keys, occupied ports and mismatched existing state', () => {
  assert.deepEqual(python(`
key='SYNTHETIC_NEW_KEY_ONLY';plan=remote['new_client_plan'];failure=remote['SafeFailure']
old={'Id':1,'Remark':'other','VerifyKey':'OTHER_SYNTHETIC_KEY'}
result=plan([old],key,False,False)
assert result['form']['remark']=='sealed-notes'
assert result['form']['max_tunnel']=='1'
assert result['form']['config_conn_allow']=='1'
for clients,reserved,listening in [([old],True,False),([old],False,True),([{'Id':1,'Remark':'other','VerifyKey':key}],False,False),([{'Id':2,'Remark':'sealed-notes','VerifyKey':'OTHER_KEY'}],False,False)]:
    try: plan(clients,key,reserved,listening)
    except failure: pass
    else: raise AssertionError('unsafe creation accepted')
existing={'Id':6,'Remark':'sealed-notes','VerifyKey':key,'ConfigConnAllow':True,'MaxTunnelNum':1}
assert plan([existing],key,True,True)=={'existing':6}
assert remote['port_reserved']([{'Port':'18780-18790'}]) is True
assert remote['port_reserved']([{'Port':18787}]) is False
print(json.dumps({'safe':True}))
`), { safe: true });
});

test('NPS API operation adds only one isolated client and verifies existing settings', () => {
  assert.deepEqual(python(`
key='SYNTHETIC_NEW_KEY_ONLY';calls=[]
old={'Id':1,'Remark':'other','VerifyKey':'OTHER_KEY','ConfigConnAllow':True,'MaxTunnelNum':10}
created={'Id':6,'Remark':'sealed-notes','VerifyKey':key,'ConfigConnAllow':True,'MaxTunnelNum':1}
def request(endpoint,form=None):
    calls.append((endpoint,form));assert endpoint=='/client/add'
    return 200,'{"status":1}'
remote['read_config']=lambda:{}
remote['api_session']=lambda config:request
remote['login']=lambda request,config:200
counter=[0]
def clients(request):
    counter[0]+=1
    return 200,[old] if counter[0]==1 else [old,created]
remote['client_rows']=clients
remote['records']=lambda filename:[{'Port':18787}]
remote['subprocess'].run=lambda *args,**kwargs:subprocess.CompletedProcess(args,0,'','')
report=remote['operate']({'operation':'create-client','vkey':key})
assert report['status']=='created' and report['clientId']==6
assert report['oldClientSettingsUnchanged'] is True
assert len(calls)==1 and calls[0][0]=='/client/add'
assert calls[0][1]['vkey']==key
assert key not in json.dumps(report) and 'OTHER_KEY' not in json.dumps(report)
print(json.dumps({'safe':True}))
`), { safe: true });
});

test('NPS login follows the installed RSA form and redirects remain loopback-only', () => {
  assert.deepEqual(python(`
calls=[];payloads=[]
page='publicKey: '+chr(96)+'-----BEGIN PUBLIC KEY-----'+chr(92)+'nQUJD'+chr(92)+'n-----END PUBLIC KEY-----'+chr(96)+', loginNonce: "nonce_123", loginDelay: 0, powBits: 0, powEnable: false'
def request(endpoint,form=None):
    calls.append((endpoint,form))
    if endpoint=='/login/index': return 200,page
    if endpoint=='/auth/gettime': return 200,'{"time":1800000000}'
    if endpoint=='/login/verify': return 200,'{"status":1}'
    raise AssertionError(endpoint)
def encrypt(key,payload):payloads.append(json.loads(payload));return 'ENCRYPTED_SYNTHETIC_ONLY'
remote['rsa_encrypt']=encrypt
assert remote['login'](request,{'web_username':'SYNTHETIC_USER','web_password':'SYNTHETIC_PASSWORD'})==200
assert payloads[0]['p']=='SYNTHETIC_PASSWORD'
assert calls[-1][1]['password']=='ENCRYPTED_SYNTHETIC_ONLY'
redirect=remote['LocalRedirect']()
try: redirect.redirect_request(None,None,302,'',{},'https://example.com/login')
except remote['SafeFailure']: pass
else: raise AssertionError('external redirect accepted')
print(json.dumps({'safe':True}))
`), { safe: true });
});

test('NPS key reader accepts only the private ignored project env', () => {
  assert.deepEqual(python(`
import tempfile,pathlib,os
with tempfile.TemporaryDirectory() as directory:
    root=pathlib.Path(directory)
    subprocess.run(['git','init','-q',directory],check=True,capture_output=True)
    (root/'.gitignore').write_text('.env\\n')
    (root/'.env').write_text('NPS_VKEY="SYNTHETIC_NEW_KEY_ONLY"\\n')
    os.chmod(root/'.env',0o600)
    assert module.local_key(root)=='SYNTHETIC_NEW_KEY_ONLY'
    os.chmod(root/'.env',0o644)
    try: module.local_key(root)
    except ValueError: pass
    else: raise AssertionError('unsafe env accepted')
print(json.dumps({'safe':True}))
`), { safe: true });
});

test('OpenSSL encrypts synthetic payload from a public-key memfd and classifies oversized input', () => {
  assert.deepEqual(python(`
generated=subprocess.run(['/usr/bin/openssl','genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:1024'],capture_output=True,check=True)
public=subprocess.run(['/usr/bin/openssl','pkey','-pubout'],input=generated.stdout,capture_output=True,check=True).stdout.decode()
for escaped in [public.replace(chr(10),chr(92)+'n'),public.replace(chr(10),chr(92)*2+'n'),public.replace('+',chr(92)*2+'u002b').replace(chr(10),chr(92)*2+'r'+chr(92)*2+'n'),public.replace('/',chr(92)+'/').replace('+',chr(92)+'u002b').replace(chr(10),chr(92)+'n'),public.replace('/',chr(92)*2+'/').replace(chr(10),chr(92)*2+'n')]:
    normalized=remote['public_key_literal'](escaped)
    encoded=remote['rsa_encrypt'](normalized,'SYNTHETIC_PASSWORD_ONLY')
    assert len(remote['base64'].b64decode(encoded))==128
    assert remote['CRYPTO_DIAGNOSTICS']['beginPublicMarkerCount']==1
    assert remote['CRYPTO_DIAGNOSTICS']['endPublicMarkerCount']==1
    assert remote['CRYPTO_DIAGNOSTICS']['invalidBodyCodepoints']==[]
encrypted=remote['rsa_encrypt'](public,'SYNTHETIC_PASSWORD_ONLY')
assert len(remote['base64'].b64decode(encrypted))==128
assert remote['CRYPTO_DIAGNOSTICS']['rsaBits']==1024
assert remote['CRYPTO_DIAGNOSTICS']['publicKeyParseSucceeded'] is True
try: remote['rsa_encrypt'](public,'x'*200)
except remote['SafeFailure'] as error: assert str(error)=='password-encryption-data-too-large'
else: raise AssertionError('oversized RSA payload accepted')
assert 'SYNTHETIC_PASSWORD_ONLY' not in json.dumps(remote['CRYPTO_DIAGNOSTICS'])
print(json.dumps({'safe':True}))
`), { safe: true });
});
