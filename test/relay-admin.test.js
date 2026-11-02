import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const helper = path.resolve(import.meta.dirname, '../tools/relay-admin.py');

test('relay inspector keeps synthetic sudo input out of arguments, environment and output', () => {
  const script = `
import importlib.util,json,subprocess,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('relay_admin',${JSON.stringify(helper)})
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
synthetic='SYNTHETIC_TEST_PASSWORD_ONLY'
captured={}
def fake(args,**kwargs):
    captured.update(args=args,**kwargs)
    return subprocess.CompletedProcess(args,0,'{"operation":"inspect","mutated":false,"euid":0}','')
report=module.inspect_relay(synthetic,runner=fake)
assert captured['input']==synthetic+'\\n'
assert synthetic not in json.dumps(captured['args'])
assert synthetic not in json.dumps(captured['env'])
assert synthetic not in json.dumps(report)
assert captured['timeout']==30
assert captured['capture_output'] is True
assert captured['args'][:2]==['ssh','-T']
assert 'sudo -S -p' in captured['args'][-1]
assert 'getpass' not in captured['args'][-1]
print(json.dumps({'safe':True,'mutated':report['mutated']}))
`;
  assert.deepEqual(JSON.parse(execFileSync('/usr/bin/python3', ['-c', script], { encoding: 'utf8' })), { safe: true, mutated: false });
});

test('relay inspector suppresses remote stderr, malformed JSON and raw exceptions', () => {
  const script = `
import importlib.util,json,subprocess,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('relay_admin',${JSON.stringify(helper)})
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
synthetic='SYNTHETIC_TEST_PASSWORD_ONLY'
def failed(args,**kwargs): return subprocess.CompletedProcess(args,1,synthetic,synthetic)
def malformed(args,**kwargs): return subprocess.CompletedProcess(args,0,synthetic,synthetic)
def exception(args,**kwargs): raise RuntimeError(synthetic)
for runner in [failed,malformed,exception]:
    report=module.inspect_relay(synthetic,runner=runner)
    assert report['status']=='failed'
    assert synthetic not in json.dumps(report)
print(json.dumps({'safe':True}))
`;
  assert.deepEqual(JSON.parse(execFileSync('/usr/bin/python3', ['-c', script], { encoding: 'utf8' })), { safe: true });
});

test('remote schema projection omits credential values and dynamic keys', () => {
  const script = `
import importlib.util,json,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('relay_admin',${JSON.stringify(helper)})
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
# Execute definitions only. No SSH, process inventory, or local private-file reads.
definitions=module.REMOTE_SCRIPT.split("\\ntry:\\n    code,text=command(['ss'")[0]
namespace={};exec(definitions,namespace)
synthetic='SYNTHETIC_TEST_PASSWORD_ONLY'
result=namespace['schema']({synthetic:{'Id':1,'VerifyKey':synthetic,'WebPassword':synthetic,'Remark':synthetic}})
serialized=json.dumps(result)
assert synthetic not in serialized
assert 'VerifyKey' in serialized and 'WebPassword' in serialized
print(json.dumps({'safe':True}))
`;
  assert.deepEqual(JSON.parse(execFileSync('/usr/bin/python3', ['-c', script], { encoding: 'utf8' })), { safe: true });
});

test('active NPS inspection derives only live cwd paths and parses public settings', () => {
  const script = `
import importlib.util,json,sys,tempfile,pathlib
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('relay_admin',${JSON.stringify(helper)})
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
definitions=module.REMOTE_SCRIPT.split("\\ntry:\\n    code,text=command(['ss'")[0]
namespace={};exec(definitions,namespace)
synthetic='SYNTHETIC_TEST_PASSWORD_ONLY'
with tempfile.TemporaryDirectory() as directory:
    conf=pathlib.Path(directory)/'conf';conf.mkdir()
    (conf/'nps.conf').write_text('web_port=6180\\nweb_ip=127.0.0.1\\nbridge_type=tls\\nbridge_port=8025\\nweb_password='+synthetic+'\\nweb_username='+synthetic+'\\n')
    (conf/'clients.json').write_text(json.dumps([{'Id':12,'VerifyKey':synthetic,'WebPassword':synthetic}]))
    result=namespace['active_installations']([{'cwd':directory}])
    assert len(result)==1
    assert result[0]['configuration']['settings']['web_port']==6180
    assert result[0]['configuration']['settings']['web_passwordPresent'] is True
    assert result[0]['databases'][0]['clientIds']==[12]
    assert synthetic not in json.dumps(result)
print(json.dumps({'safe':True}))
`;
  assert.deepEqual(JSON.parse(execFileSync('/usr/bin/python3', ['-c', script], { encoding: 'utf8' })), { safe: true });
});
