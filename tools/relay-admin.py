#!/usr/bin/python3
"""Inspect the relay through a fixed, credential-safe SSH command."""

import argparse
import getpass
import json
import os
import shlex
import subprocess
import sys


REMOTE_SCRIPT = r'''
import configparser,json,os,re,subprocess
from pathlib import Path

def command(args):
    try:
        result=subprocess.run(args,capture_output=True,text=True,timeout=8,check=False)
        return result.returncode,result.stdout
    except Exception:
        return None,''

FIELDS=set('Id id ClientId client_id Client client Clients clients Task Tasks tasks Host Hosts hosts Flow RateLimit FlowLimit MaxConn MaxTunnelNum Remark Status IsConnect Cnf VerifyKey Password WebUserName WebPassword WebAuth IsPub NoStore NoDisplay NoRedis Addr Version Mode BlackIpList LocalProxy LastOnlineTime NowConn AutoReconnect ConfigConnAllow PublicKey PublicVkey Username UserName Key Port ServerIp Target TargetAddr TargetPort TargetMode TargetType HttpProxy HostChange HeaderChange Location Scheme CertFile KeyFile HealthCheckTimeout HealthCheckInterval HealthMaxFail HealthNextTime HealthMap HealthRemoveArr FlowExport FlowInlet InletFlow ExportFlow TimeLimit MaxConn ConnLimit AllowConfig AllowProxy TlsEnable ProxyProtocol TransMode Compress Crypt Udp PacketLen ServerId ServerPort WebPort WebIp BridgePort BridgeIp BridgeType PublicVKey DnsServer NtpServer'.split())

def schema(value):
    found={}
    def visit(item,location,depth):
        if depth>5: return
        if isinstance(item,list):
            for child in item[:64]: visit(child,location+'[]',depth+1)
        elif isinstance(item,dict):
            fields=found.setdefault(location,{'fields':set(),'unknownFieldCount':0})
            known=[key for key in item if isinstance(key,str) and key in FIELDS]
            fields['fields'].update(known)
            fields['unknownFieldCount']=max(fields['unknownFieldCount'],len(item)-len(known))
            for key in known:
                if isinstance(item[key],(dict,list)): visit(item[key],location+'.'+key,depth+1)
            # Numeric/dynamic map keys can contain credentials; never print them.
            for key,child in list(item.items())[:64]:
                if key not in known and isinstance(child,(dict,list)): visit(child,location+'.*',depth+1)
    visit(value,'$',0)
    return [{'path':key,'fields':sorted(value['fields']),'unknownFieldCount':value['unknownFieldCount']} for key,value in sorted(found.items())]

def database(filename):
    result={'path':filename,'exists':Path(filename).is_file()}
    if not result['exists']: return result
    try:
        if Path(filename).stat().st_size>8*1024*1024:
            result['status']='too-large';return result
        text=Path(filename).read_text()
        try: data=json.loads(text);format='json'
        except ValueError:
            data=[json.loads(line) for line in text.splitlines() if line.strip()];format='ndjson'
        if isinstance(data,list): records=data
        elif isinstance(data,dict):
            records=next((data[key] for key in ['clients','Clients','tasks','Tasks','hosts','Hosts'] if isinstance(data.get(key),list)),None)
            if records is None: records=list(data.values()) if data and all(isinstance(v,dict) for v in data.values()) else [data]
        else: records=[]
        result.update(status='readable',format=format,recordCount=len(records),schema=schema(data))
        if filename.endswith('/clients.json'):
            result['clientIds']=sorted({record['Id'] for record in records if isinstance(record,dict) and type(record.get('Id')) is int and 0<=record['Id']<=2147483647})[:100]
    except Exception: result['status']='unavailable'
    return result

def nps_config(filename='/etc/nps/conf/nps.conf'):
    result={'path':str(filename)}
    public={'bridge_type','bridge_port','bridge_ip','web_port','web_ip','allow_ports'}
    presence={'web_username','web_password','auth_key','public_vkey'}
    try:
        text=Path(result['path']).read_text()
        values={}
        for line in text.splitlines():
            match=re.match(r'^\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$',line)
            if not match or line.lstrip().startswith(('#',';')): continue
            key,value=match.groups()
            value=value.split('#',1)[0].split(';',1)[0].strip()
            if key in presence: values[key+'Present']=bool(value)
            if key in public:
                # Malformed settings are not echoed; a credential cannot masquerade as a port.
                if key=='bridge_type' and value in ['tcp','tls','kcp','quic','ws','wss']: values[key]=value
                elif key.endswith('_port') and value.isdigit() and 0<=int(value)<=65535: values[key]=int(value)
                elif key.endswith('_ip') and re.fullmatch(r'[0-9a-fA-F:.]{1,45}',value): values[key]=value
                elif key=='allow_ports' and re.fullmatch(r'[0-9,\- ]{0,256}',value): values[key]=value
                else: values[key+'Malformed']=True
        result.update(status='readable',settings=values)
    except Exception: result['status']='unavailable'
    return result

def processes():
    result=[]
    for proc in Path('/proc').glob('[0-9]*'):
        try:
            if (proc/'comm').read_text().strip()!='nps': continue
            ppid=int(next(line.split()[1] for line in (proc/'status').read_text().splitlines() if line.startswith('PPid:')))
            result.append({'pid':int(proc.name),'executable':os.readlink(proc/'exe'),'cwd':os.readlink(proc/'cwd'),'parentPid':ppid,'parentCommand':(Path('/proc')/str(ppid)/'comm').read_text().strip()})
        except Exception: continue
    return result

def active_installations(process_info):
    result=[]
    # Derive paths only from the live NPS process cwd, never from user input.
    for cwd in sorted({item['cwd'] for item in process_info if Path(item['cwd']).is_absolute()}):
        directory=Path(cwd)
        configurations=[directory/'conf/nps.conf',directory/'nps.conf']
        for config in configurations:
            if not config.is_file(): continue
            conf=config.parent
            result.append({'cwd':cwd,'configuration':nps_config(config),'databases':[database(str(conf/name)) for name in ['clients.json','global.json','hosts.json','tasks.json']]})
    return result

def supervisors():
    code,text=command(['systemctl','list-unit-files','--no-legend','--no-pager'])
    names={line.split()[0] for line in text.splitlines() if line.split() and re.fullmatch(r'[A-Za-z0-9_.@-]+\.service',line.split()[0]) and re.search(r'nps|npc|supervisor|docker|podman',line.split()[0],re.I)}
    result=[]
    for name in sorted(names)[:20]:
        code,text=command(['systemctl','show',name,'--property=FragmentPath','--property=ActiveState','--property=SubState','--property=MainPID','--no-pager'])
        fields={line.split('=',1)[0]:line.split('=',1)[1] for line in text.splitlines() if '=' in line and line.split('=',1)[0] in ['FragmentPath','ActiveState','SubState','MainPID']}
        result.append({'unit':name,**fields})
    return result

def accounts():
    try:
        ids=sorted({p.parent.name for p in Path('/etc/letsencrypt/accounts').rglob('regr.json') if re.fullmatch(r'[a-fA-F0-9]{16,128}',p.parent.name)})
        return {'count':len(ids),'accountIds':ids}
    except Exception: return {'status':'unavailable'}

def renewal_accounts():
    result=[]
    # Account identifiers and ACME directory URLs are public metadata.
    for filename in ['/etc/letsencrypt/renewal/twitchapi.wilflin.me.conf','/etc/letsencrypt/renewal/wilflin.me.conf']:
        item={'path':filename}
        try:
            values={}
            with open(filename) as source:
                for line in source:
                    match=re.match(r'^\s*(account|server)\s*=\s*([^#;]*)',line)
                    if match: values[match.group(1)]=match.group(2).strip()
            account=values.get('account','')
            if re.fullmatch(r'[a-fA-F0-9]{16,128}',account): item['accountId']=account
            server=values.get('server','')
            if server in ['https://acme-v02.api.letsencrypt.org/directory','https://acme-staging-v02.api.letsencrypt.org/directory']:
                item['server']=server
                item['production']=server=='https://acme-v02.api.letsencrypt.org/directory'
            else: item['serverRecognized']=False
            item['status']='readable'
        except Exception: item['status']='unavailable'
        result.append(item)
    return result

def nginx():
    files=[]
    for filename in ['/etc/nginx/sites-available/notes.wilflin.me','/etc/nginx/sites-enabled/notes.wilflin.me']:
        p=Path(filename);item={'path':filename,'exists':p.exists(),'symlink':p.is_symlink()}
        if p.is_file():
            selected=[]
            for number,line in enumerate(p.read_text().splitlines(),1):
                line=line.strip()
                if (re.fullmatch(r'listen [0-9\[\]: a-z_]+;.*',line) or re.fullmatch(r'server_name notes\.wilflin\.me;',line) or re.fullmatch(r'proxy_pass http://127\.0\.0\.1:[0-9]+;',line) or re.fullmatch(r'return (?:404|403);',line)):
                    selected.append({'line':number,'directive':line})
            item['publicDirectives']=selected
        files.append(item)
    code,_=command(['/usr/sbin/nginx','-t'])
    return {'syntaxExitCode':code,'sitesAvailableWritable':os.access('/etc/nginx/sites-available',os.W_OK),'sitesEnabledWritable':os.access('/etc/nginx/sites-enabled',os.W_OK),'notesFiles':files}

try:
    code,text=command(['ss','-H','-ltn','( sport = :18788 )'])
    listeners=[]
    for line in text.splitlines():
        fields=line.split()
        if len(fields)>3 and re.fullmatch(r'[0-9a-fA-F:.\[\]*]+:18788',fields[3]): listeners.append(fields[3])
    process_info=processes()
    result={'operation':'inspect','euid':os.geteuid(),'nps':{'configuration':nps_config(),'databases':[database('/etc/nps/conf/'+name) for name in ['clients.json','global.json','hosts.json']],'processes':process_info,'activeInstallations':active_installations(process_info),'supervisors':supervisors()},'certbot':{'accounts':accounts(),'renewalAccounts':renewal_accounts()},'nginx':nginx(),'relayPort18788':{'commandExitCode':code,'listeners':listeners,'reservationVerified':False},'mutated':False}
    print(json.dumps(result,separators=(',',':')))
except Exception:
    print(json.dumps({'operation':'inspect','status':'failed','reason':'Relay inspection could not complete.','mutated':False}))
    raise SystemExit(1)
'''


def inspect_relay(password, runner=subprocess.run):
    command = [
        "ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
        "admin@wilflin.me",
        "sudo -S -p '' /usr/bin/python3 -c " + shlex.quote(REMOTE_SCRIPT),
    ]
    environment = {key: os.environ[key] for key in ["PATH", "HOME", "SSH_AUTH_SOCK"] if key in os.environ}
    try:
        result = runner(command, input=password + "\n", text=True, capture_output=True,
                        timeout=30, check=False, env=environment)
        if result.returncode != 0:
            return {"operation": "inspect", "status": "failed", "exitCode": result.returncode,
                    "reason": "SSH, sudo, or relay inspection failed.", "mutated": False}
        parsed = json.loads(result.stdout)
        if not isinstance(parsed, dict) or parsed.get("operation") != "inspect" or parsed.get("mutated") is not False:
            raise ValueError("Unexpected inspection response")
        return parsed
    except Exception:
        return {"operation": "inspect", "status": "failed",
                "reason": "Relay inspection did not return a valid response.", "mutated": False}
    finally:
        password = None


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read-only relay inspection; password uses stdin only.")
    parser.add_argument("--inspect", action="store_true", required=True)
    parser.parse_args(argv)
    password = None
    try:
        if not sys.stdin.isatty():
            raise ValueError("A terminal is required for private password input")
        password = getpass.getpass("Relay sudo password: ")
        if not password or "\n" in password or "\r" in password:
            raise ValueError("Invalid password input")
        report = inspect_relay(password)
        print(json.dumps(report, indent=2, sort_keys=True))
        return 1 if report.get("status") == "failed" else 0
    except (Exception, KeyboardInterrupt):
        print(json.dumps({"operation": "inspect", "status": "failed",
                          "reason": "Relay inspection could not start.", "mutated": False}))
        return 1
    finally:
        password = None


if __name__ == "__main__":
    sys.exit(main())
