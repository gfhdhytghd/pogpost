#!/usr/bin/python3
"""Inspect NPS's loopback admin API and explicitly add one isolated client."""

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys


REMOTE_SCRIPT = r'''
import base64,hashlib,hmac,http.cookiejar,json,os,re,subprocess,sys,time,urllib.parse,urllib.request
from pathlib import Path

class SafeFailure(Exception): pass
def fail(reason): raise SafeFailure(reason)
CRYPTO_DIAGNOSTICS={}

def read_config():
    result={}
    for line in Path('/home/admin/npsc/conf/nps.conf').read_text().splitlines():
        match=re.match(r'^\s*(web_port|web_base_url|web_username|web_password)\s*=\s*(.*?)\s*$',line)
        if match: result[match.group(1)]=match.group(2).strip()
    if result.get('web_port')!='6180': fail('web-port-changed')
    if not result.get('web_username') or not result.get('web_password'): fail('web-credentials-unavailable')
    prefix=result.get('web_base_url','').rstrip('/')
    if not re.fullmatch(r'(?:/[A-Za-z0-9_-]+)*',prefix): fail('unsupported-web-base')
    result['prefix']=prefix
    return result

def records(filename):
    file=Path('/home/admin/npsc/conf')/filename
    if file.stat().st_size>8*1024*1024: fail('database-too-large')
    text=file.read_text()
    try: data=json.loads(text)
    except ValueError: data=[json.loads(line) for line in text.splitlines() if line.strip()]
    if isinstance(data,list): return data
    if isinstance(data,dict) and 'Id' in data: return [data]
    if isinstance(data,dict) and all(isinstance(value,dict) for value in data.values()): return list(data.values())
    fail('unsupported-database-format')

def port_reserved(tasks):
    for task in tasks:
        if not isinstance(task,dict): fail('unsupported-task-record')
        value=task.get('Port',task.get('port'))
        if type(value) is int and value==18788: return True
        if isinstance(value,str):
            for segment in value.split(','):
                if re.fullmatch(r'\d+',segment.strip()) and int(segment)==18788: return True
                match=re.fullmatch(r'\s*(\d+)-(\d+)\s*',segment)
                if match and int(match.group(1))<=18788<=int(match.group(2)): return True
    return False

class LocalRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,request,response,code,message,headers,url):
        parsed=urllib.parse.urlsplit(url)
        if parsed.scheme!='http' or parsed.hostname!='127.0.0.1' or parsed.port!=6180 or parsed.username or parsed.password:
            fail('nonlocal-redirect-denied')
        return super().redirect_request(request,response,code,message,headers,url)

def api_session(config):
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),LocalRedirect())
    base='http://127.0.0.1:6180'+config['prefix']
    def request(endpoint,form=None):
        data=None if form is None else urllib.parse.urlencode(form).encode()
        req=urllib.request.Request(base+endpoint,data=data,headers={'Content-Type':'application/x-www-form-urlencoded','Origin':'http://127.0.0.1:6180','Referer':base+'/login/index'})
        with opener.open(req,timeout=5) as response:
            body=response.read(2*1024*1024+1)
            if len(body)>2*1024*1024: fail('api-response-too-large')
            return response.status,body.decode('utf-8')
    return request

def rsa_encrypt(public_key,payload):
    fd=os.memfd_create('nps-public-key',flags=0)
    try:
        os.fchmod(fd,0o600);os.write(fd,public_key.encode());os.lseek(fd,0,os.SEEK_SET)
        CRYPTO_DIAGNOSTICS.update(publicKeyByteCount=len(public_key.encode()),payloadByteCount=len(payload.encode()))
        parsed=subprocess.run(['/usr/bin/openssl','pkey','-pubin','-in','/proc/self/fd/'+str(fd),'-noout','-text'],capture_output=True,pass_fds=(fd,),timeout=5,check=False,env={'PATH':'/usr/bin:/bin'})
        bits=re.search(rb'Public-Key:\s*\((\d+) bit\)',parsed.stdout)
        CRYPTO_DIAGNOSTICS['rsaBits']=int(bits.group(1)) if bits else None
        CRYPTO_DIAGNOSTICS['publicKeyParseSucceeded']=parsed.returncode==0
        if parsed.returncode: fail('password-encryption-key-invalid')
        result=subprocess.run(['/usr/bin/openssl','pkeyutl','-encrypt','-pubin','-inkey','/proc/self/fd/'+str(fd),'-pkeyopt','rsa_padding_mode:pkcs1'],input=payload.encode(),capture_output=True,pass_fds=(fd,),timeout=5,check=False,env={'PATH':'/usr/bin:/bin'})
        if result.returncode:
            diagnostic=result.stderr.decode(errors='replace').lower()
            if 'data too large' in diagnostic: fail('password-encryption-data-too-large')
            if 'no such file' in diagnostic or 'bad file descriptor' in diagnostic: fail('password-encryption-key-fd')
            if 'could not read' in diagnostic or 'unable to load' in diagnostic: fail('password-encryption-key-invalid')
            if 'unsupported' in diagnostic: fail('password-encryption-key-unsupported')
            fail('password-encryption-failed')
        return base64.b64encode(result.stdout).decode()
    finally: os.close(fd)

def public_key_literal(value):
    # Go html/template can escape newlines and base64 characters in JS literals.
    # Normalize escaped backslashes before newline escapes. This also accepts the
    # doubly escaped PEM emitted by the installed template without evaluating JS.
    CRYPTO_DIAGNOSTICS['escapeKinds']=sorted({character if character in '/nrtux\\"\x27' else 'codepoint-'+str(ord(character)) for character in re.findall(r'\\(.)',value)})
    for _ in range(3):
        previous=value
        value=value.replace('\\\\','\\')
        value=re.sub(r'\\u([0-9a-fA-F]{4})',lambda match:chr(int(match.group(1),16)),value)
        value=re.sub(r'\\x([0-9a-fA-F]{2})',lambda match:chr(int(match.group(1),16)),value)
        value=value.replace('\\n','\n').replace('\\r','\r').replace('\\t','\t').replace('\\/','/')
        if value==previous: break
    CRYPTO_DIAGNOSTICS['normalizedPEMByteCount']=len(value.encode())
    CRYPTO_DIAGNOSTICS['beginPublicMarkerCount']=value.count('-----BEGIN PUBLIC KEY-----')+value.count('-----BEGIN RSA PUBLIC KEY-----')
    CRYPTO_DIAGNOSTICS['endPublicMarkerCount']=value.count('-----END PUBLIC KEY-----')+value.count('-----END RSA PUBLIC KEY-----')
    body_candidate=re.sub(r'-----BEGIN [A-Z ]+-----|-----END [A-Z ]+-----','',value)
    CRYPTO_DIAGNOSTICS['invalidBodyCodepoints']=sorted({ord(character) for character in body_candidate if character not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/= \t\r\n'})
    match=re.fullmatch(r'\s*-----BEGIN (PUBLIC KEY|RSA PUBLIC KEY)-----\s*([A-Za-z0-9+/=\s]+)-----END \1-----\s*',value)
    if not match: fail('password-encryption-key-invalid')
    body=re.sub(r'\s+','',match.group(2))
    try: base64.b64decode(body,validate=True)
    except Exception: fail('password-encryption-key-invalid')
    lines='\n'.join(body[offset:offset+64] for offset in range(0,len(body),64))
    return '-----BEGIN '+match.group(1)+'-----\n'+lines+'\n-----END '+match.group(1)+'-----\n'

def login(request,config):
    status,page=request('/login/index')
    if re.search(r'<input\b[^>]*name=["\x27]captcha["\x27]',page,re.I): fail('interactive-captcha-required')
    key=re.search(r'publicKey\s*:\s*`([^`]+)`',page,re.S)
    nonce=re.search(r'loginNonce\s*:\s*"([A-Za-z0-9_-]{1,512})"',page)
    delay=re.search(r'loginDelay\s*:\s*(\d+)',page)
    bits=re.search(r'powBits\s*:\s*(\d+)',page)
    enabled=re.search(r'powEnable\s*:\s*(true|false)',page)
    if not all([key,nonce,delay,bits,enabled]) or len(key.group(1))>8192: fail('unsupported-login-protocol')
    delay_ms=int(delay.group(1));pow_bits=int(bits.group(1))
    if delay_ms>5000 or pow_bits>20: fail('login-work-limit-exceeded')
    clock=json.loads(request('/auth/gettime')[1]).get('time')
    if not isinstance(clock,(int,float)) or clock<1000000000: fail('invalid-server-clock')
    CRYPTO_DIAGNOSTICS['keyHasEscapedNewlines']='\\n' in key.group(1)
    CRYPTO_DIAGNOSTICS['literalKeyByteCount']=len(key.group(1).encode())
    CRYPTO_DIAGNOSTICS['keyStartsPEM']=key.group(1).lstrip().startswith('-----BEGIN')
    encrypted=rsa_encrypt(public_key_literal(key.group(1)),json.dumps({'n':nonce.group(1),'t':int(clock*1000),'p':config['web_password']},separators=(',',':')))
    form={'username':config['web_username'],'password':encrypted}
    if enabled.group(1)=='true' and pow_bits:
        deadline=time.monotonic()+5
        counter=0
        while time.monotonic()<deadline:
            digest=int.from_bytes(hashlib.sha256((encrypted+str(counter)).encode()).digest(),'big')
            if digest>>(256-pow_bits)==0:
                form.update(powx=str(counter),bits=str(pow_bits));break
            counter+=1
        else: fail('login-proof-timeout')
    time.sleep(delay_ms/1000)
    status,body=request('/login/verify',form)
    if json.loads(body).get('status') not in [True,1]: fail('login-rejected')
    return status

def client_rows(request):
    status,body=request('/client/list',{'offset':'0','limit':'0','order':'asc'})
    data=json.loads(body)
    rows=data.get('rows') if isinstance(data,dict) else None
    if not isinstance(rows,list) or type(data.get('total')) is not int or data['total']!=len(rows): fail('incomplete-client-list')
    if any(not isinstance(row,dict) or type(row.get('Id')) is not int for row in rows): fail('invalid-client-list')
    return status,rows

def key_matches(client,key):
    value=client.get('VerifyKey')
    return isinstance(value,str) and hmac.compare_digest(value,key)

def new_client_plan(clients,key,reserved,listening):
    if not isinstance(key,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}',key): fail('invalid-new-client-key')
    matching=[client for client in clients if client.get('Remark')=='sealed-notes']
    if len(matching)>1: fail('duplicate-sealed-notes-clients')
    if matching:
        client=matching[0]
        if not key_matches(client,key): fail('existing-client-key-mismatch')
        if client.get('ConfigConnAllow') is not True or client.get('MaxTunnelNum')!=1: fail('existing-client-policy-mismatch')
        return {'existing':client['Id']}
    if any(key_matches(client,key) for client in clients): fail('new-key-belongs-to-another-client')
    if reserved or listening: fail('relay-port-18788-unavailable')
    return {'form':{'remark':'sealed-notes','vkey':key,'config_conn_allow':'1','max_tunnel':'1','max_conn':'','flow_limit':'','time_limit':'','rate_limit':'','u':'','p':'','web_username':'','web_password':'','compress':'0','crypt':'0','blackiplist':''}}

def immutable(client):
    return {field:client.get(field) for field in ['Id','VerifyKey','Remark','ConfigConnAllow','MaxTunnelNum','WebUserName','WebPassword','Cnf']}

def operate(payload):
    operation=payload.get('operation')
    if operation not in ['inspect-api','create-client']: fail('unsupported-operation')
    config=read_config();request=api_session(config)
    login_status=login(request,config)
    list_status,clients=client_rows(request)
    tasks=records('tasks.json');reserved=port_reserved(tasks)
    sockets=subprocess.run(['ss','-H','-ltn','( sport = :18788 )'],capture_output=True,text=True,timeout=5,check=False)
    if sockets.returncode: fail('listener-check-failed')
    listening=bool(sockets.stdout.strip())
    result={'operation':operation,'status':'inspected','loginHttpStatus':login_status,'listHttpStatus':list_status,'clientCount':len(clients),'clientIds':sorted(row['Id'] for row in clients),'sealedNotesClientIds':[row['Id'] for row in clients if row.get('Remark')=='sealed-notes'],'clientSchemaFields':sorted({field for row in clients for field in row if field in ['Id','VerifyKey','Remark','ConfigConnAllow','MaxTunnelNum','Cnf','Flow','Status','WebUserName','WebPassword']}),'taskCount':len(tasks),'relayPort18788Reserved':reserved,'relayPort18788Listening':listening,'mutated':False}
    if operation=='inspect-api':
        result['cryptoDiagnostics']=dict(CRYPTO_DIAGNOSTICS)
        return result
    plan=new_client_plan(clients,payload.get('vkey'),reserved,listening)
    if 'existing' in plan:
        result.update(status='existing',clientId=plan['existing'],remark='sealed-notes');return result
    before={row['Id']:immutable(row) for row in clients}
    result['mutated']=True
    _,body=request('/client/add',plan['form'])
    if json.loads(body).get('status') not in [True,1]: fail('client-add-rejected')
    _,after=client_rows(request)
    old_unchanged=all(any(row['Id']==identifier and immutable(row)==snapshot for row in after) for identifier,snapshot in before.items())
    created=[row for row in after if row.get('Remark')=='sealed-notes' and key_matches(row,payload['vkey'])]
    if not old_unchanged or len(after)!=len(clients)+1 or len(created)!=1 or created[0].get('ConfigConnAllow') is not True or created[0].get('MaxTunnelNum')!=1: fail('post-create-verification-failed')
    result.update(status='created',clientId=created[0]['Id'],remark='sealed-notes',oldClientSettingsUnchanged=True)
    return result

if __name__=='__main__':
    operation='unknown'
    try:
        line=sys.stdin.readline(2049)
        if len(line)>2048: fail('payload-too-large')
        payload=json.loads(line);operation=payload.get('operation','unknown')
        print(json.dumps(operate(payload),separators=(',',':')))
    except SafeFailure as error:
        report={'operation':operation if operation in ['inspect-api','create-client'] else 'unknown','status':'failed','reason':str(error),'mutationOutcome':'unconfirmed' if operation=='create-client' else 'none'}
        if operation=='inspect-api': report['cryptoDiagnostics']=dict(CRYPTO_DIAGNOSTICS)
        print(json.dumps(report))
        raise SystemExit(1)
    except Exception:
        print(json.dumps({'operation':operation if operation in ['inspect-api','create-client'] else 'unknown','status':'failed','reason':'nps-operation-failed','mutationOutcome':'unconfirmed' if operation=='create-client' else 'none'}))
        raise SystemExit(1)
'''


def local_key(root=None):
    root = Path(root) if root else Path(__file__).resolve().parent.parent
    descriptor = os.open(root / '.env', os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
            raise ValueError('Private project credentials are required')
        result = subprocess.run(['git', 'check-ignore', '--quiet', '--', '.env'], cwd=root, capture_output=True, check=False)
        tracked = subprocess.run(['git', 'ls-files', '--error-unmatch', '--', '.env'], cwd=root, capture_output=True, check=False)
        if result.returncode or not tracked.returncode:
            raise ValueError('Private project credentials are required')
        with os.fdopen(descriptor) as source:
            descriptor = None
            value = None
            for line in source:
                match = re.match(r'^\s*NPS_VKEY\s*=\s*(.*?)\s*$', line)
                if match:
                    raw = match.group(1)
                    value = json.loads(raw) if raw.startswith('"') else raw
        if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', value):
            raise ValueError('A distinct NPS_VKEY is required')
        return value
    finally:
        if descriptor is not None:
            os.close(descriptor)


def remote_operation(password, payload, runner=subprocess.run):
    args = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'admin@wilflin.me',
            "sudo -k -S -p '' /usr/bin/python3 -c " + shlex.quote(REMOTE_SCRIPT)]
    environment = {key: os.environ[key] for key in ['PATH', 'HOME', 'SSH_AUTH_SOCK'] if key in os.environ}
    try:
        result = runner(args, input=password + '\n' + json.dumps(payload) + '\n', text=True,
                        capture_output=True, timeout=45, check=False, env=environment)
        report = json.loads(result.stdout)
        if not isinstance(report, dict) or report.get('operation') != payload['operation']:
            raise ValueError('Invalid response')
        if result.returncode and report.get('status') != 'failed':
            raise ValueError('Failed operation')
        return report
    except Exception:
        return {'operation': payload['operation'], 'status': 'failed', 'reason': 'SSH, sudo, or NPS operation failed.',
                'mutationOutcome': 'unconfirmed' if payload['operation'] == 'create-client' else 'none'}
    finally:
        password = None


def main(argv=None):
    parser = argparse.ArgumentParser(description='Inspect or explicitly provision one isolated NPS client.')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--inspect-api', action='store_true')
    group.add_argument('--create-client', action='store_true')
    options = parser.parse_args(argv)
    password = None
    payload = None
    try:
        if not sys.stdin.isatty():
            raise ValueError('Private terminal input is required')
        payload = {'operation': 'create-client' if options.create_client else 'inspect-api'}
        if options.create_client:
            payload['vkey'] = local_key()
        password = getpass.getpass('Relay sudo password: ')
        if not password or '\r' in password or '\n' in password:
            raise ValueError('Invalid password input')
        report = remote_operation(password, payload)
        print(json.dumps(report, indent=2, sort_keys=True))
        return 1 if report.get('status') == 'failed' else 0
    except (Exception, KeyboardInterrupt):
        print(json.dumps({'status': 'failed', 'reason': 'NPS operation could not start.'}))
        return 1
    finally:
        password = None
        payload = None


if __name__ == '__main__':
    sys.exit(main())
