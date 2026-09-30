import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createManagerServer, dashboardAgentPlist } from './manager.mjs';

test('each tunnel stamps its stable account ID on MCP calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-computer-origin-'));
  try {
    const key = join(dir, 'key'), fake = join(dir, 'tunnel-client'), capture = join(dir, 'args');
    await writeFile(key, 'sk-test\n');
    await writeFile(fake, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\n', { mode: 0o755 });
    const accountId = 'a'.repeat(64);
    const result = spawnSync('bash', [join(import.meta.dirname, 'run-tunnel.sh'), key, dir, fake, 'account-test', accountId],
      { env: { ...process.env, CAPTURE: capture }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readFile(capture, 'utf8')).trim().split('\n'),
      ['run', '--profile', 'account-test', '--mcp.extra-headers', `X-Chat-Bridge-Origin-Account: ${accountId}`]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('dashboard launch agent runs the bundled manager at login', () => {
  const plist = dashboardAgentPlist('/Users/test/Applications/ChatGPT Computer.app/Contents/Resources/runtime', '/Users/test/Library/Application Support/ChatGPT Computer');
  assert.match(plist, /com\.luxiaolei\.chatgpt-computer\.manager/);
  assert.match(plist, /manager\.mjs/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
});

test('local manager requires its session and rejects cross-origin changes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chatgpt-computer-manager-'));
  const { server, token } = await createManagerServer({ dataDir, port: 0, runtimeDir: dataDir });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    const login = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
    assert.equal(login.status, 303);
    assert.match(login.headers.get('set-cookie'), /Max-Age=604800/);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/status`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/backend/start`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'https://example.com' }, body: '{}',
    })).status, 403);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('two accounts retain separate private runtime keys without exposing them in status', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chatgpt-computer-accounts-'));
  const fakeTunnel = join(dataDir, 'tunnel-client');
  await writeFile(fakeTunnel, '#!/bin/sh\nexit 0\n');
  await chmod(fakeTunnel, 0o755);
  const { server, token } = await createManagerServer({ dataDir, port: 0, runtimeDir: dataDir });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const post = (body) => fetch(`${base}/api/account`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    for (const [label, digit] of [['Personal', 'a'], ['Work', 'b']]) {
      const response = await post({ label, tunnelId: `tunnel_${digit.repeat(32)}`, apiKey: `sk-${digit}` });
      assert.equal(response.status, 200);
      assert.equal(JSON.stringify(await response.json()).includes(`sk-${digit}`), false);
    }
    const stored = await readFile(join(dataDir, 'accounts.json'), 'utf8');
    assert.equal(stored.includes('sk-a') || stored.includes('sk-b'), false);
    const secrets = await readdir(join(dataDir, 'secrets'));
    assert.equal(secrets.length, 2);
    const values = await Promise.all(secrets.map(name => readFile(join(dataDir, 'secrets', name), 'utf8')));
    assert.deepEqual(values.sort(), ['sk-a\n', 'sk-b\n']);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('authenticated dashboard reads a sanitized Bridge summary', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chatgpt-computer-dashboard-'));
  const configDir = join(dataDir, 'bridge-config');
  const stateDir = join(dataDir, 'bridge-state');
  await mkdir(configDir); await mkdir(stateDir);
  await writeFile(join(configDir, 'registry.json'), JSON.stringify({
    accounts: { work: { label: '工作账号', identity: 'secret-user', identifiedAt: 'today' } },
    projects: { Project: { activeAccount: 'work', projectUrl: 'https://private.example' } },
  }));
  const { server, token } = await createManagerServer({ dataDir, port: 0, runtimeDir: dataDir, bridgeDirs: { configDir, stateDir } });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/bridge`)).status, 401);
    const login = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`${base}/api/bridge`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.accounts, [{ id: createHash('sha256').update('identity:secret-user').digest('hex'), aliases: ['work'], label: '工作账号', identified: true }]);
    assert.doesNotMatch(JSON.stringify(payload), /secret-user|private\.example/);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('connection can bind a verified login independently of its display label', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chatgpt-computer-binding-'));
  const configDir = join(dataDir, 'bridge-config'); const stateDir = join(dataDir, 'bridge-state');
  await mkdir(configDir); await mkdir(stateDir);
  await writeFile(join(configDir, 'registry.json'), JSON.stringify({ accounts: { work: { identity: 'user-work', identifiedAt: 'today' } }, projects: {} }));
  await writeFile(join(dataDir, 'tunnel-client'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const { server, token } = await createManagerServer({ dataDir, port: 0, runtimeDir: dataDir, bridgeDirs: { configDir, stateDir } });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `manager=${token}`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const created = await (await post('/api/account', { label: 'Old Space', tunnelId: `tunnel_${'a'.repeat(32)}`, apiKey: 'sk-test' })).json();
    const id = createHash('sha256').update('identity:user-work').digest('hex');
    assert.equal((await post(`/api/account/${created.account.id}/update`, { label: 'Work', accountId: id })).status, 200);
    const status = await (await fetch(`${base}/api/status`, { headers: { cookie } })).json();
    assert.equal(status.accounts[0].label, 'Work');
    assert.equal(status.accounts[0].accountId, id);
    assert.equal((await post(`/api/account/${created.account.id}/update`, { label: 'Bad', accountId: '0'.repeat(64) })).status, 400);
    const stored = JSON.parse(await readFile(join(dataDir, 'accounts.json'), 'utf8'));
    assert.equal(stored[0].label, 'Work');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('project settings save through coordinator and read back in dashboard', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chatgpt-computer-project-config-'));
  const configDir = join(dataDir, 'bridge-config'); const stateDir = join(dataDir, 'bridge-state');
  await mkdir(configDir); await mkdir(stateDir);
  await writeFile(join(configDir, 'registry.json'), JSON.stringify({
    defaultAccount: 'a', accounts: { a: { identity: 'one' }, b: { identity: 'two' } },
    projects: { HZ: { activeAccount: 'a', bindings: { a: { projectUrl: 'https://chatgpt.com/g/g-p-one/project' }, b: { projectUrl: 'https://chatgpt.com/g/g-p-two/project' } } } }, chats: {},
  }));
  const coordinatorPath = join(dataDir, 'fake-coordinator.py');
  await writeFile(coordinatorPath, `import json,pathlib,sys
action,config,state,*args=sys.argv[1:]
path=pathlib.Path(config)/'registry.json'
if action=='configure':
    data=json.loads(args[0]); reg=json.loads(path.read_text())
    reg['projects'][data['project']]['name']=data['name']
    reg['projects'][data['project']]['allowedAccounts']=data['allowedAccounts']
    path.write_text(json.dumps(reg)); print(json.dumps({'ok':True}))
elif action=='control' and args[0]=='status':
    print(json.dumps({'projects':[{'project':'HZ OS','admission':{'mode':'RUNNING','acceptingNewWork':True},'tasks':{'active':1,'blocked':0,'failed':0},'attention':{'unknownOperations':0,'pendingManagement':0,'awaitingControllerAck':0}}]}))
else: print(json.dumps({'operations':[]}))
`);
  const { server, token } = await createManagerServer({ dataDir, port: 0, runtimeDir: dataDir, bridgeDirs: { configDir, stateDir, coordinatorPath } });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `manager=${token}`;
  try {
    const saved = await fetch(`${base}/api/bridge/config`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'project', project: 'HZ', name: 'HZ OS', allowedAccounts: ['b'] }) });
    assert.equal(saved.status, 200, await saved.text());
    const bridge = await (await fetch(`${base}/api/bridge`, { headers: { cookie } })).json();
    assert.equal(bridge.projects[0].displayName, 'HZ OS');
    assert.deepEqual(bridge.projects[0].allowedAccounts, ['b']);
    assert.equal(bridge.control.projects[0].admission.acceptingNewWork, true);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('dashboard saves explicit shared capabilities and preserves them when only folders change', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chatgpt-computer-access-'));
  const { server, token } = await createManagerServer({ dataDir, port: 0, runtimeDir: dataDir });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `manager=${token}`;
  const post = body => fetch(`${base}/api/config`, {
    method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post({ roots: [dataDir], capabilities: { write: true, commands: true, screenView: true, screenControl: false } })).status, 200);
    const status = await (await fetch(`${base}/api/status`, { headers: { cookie } })).json();
    assert.deepEqual(status.capabilities, { write: true, commands: true, screenView: true, screenControl: false });
    assert.deepEqual(status.roots, [await realpath(dataDir)]);
    assert.equal((await post({ roots: [dataDir] })).status, 200);
    const saved = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8'));
    assert.deepEqual(saved.shell.allowedCommands, ['*']);
    assert.equal(saved.filesystem.write, true);
    assert.equal(saved.desktop.screenCapture, true);
    assert.equal(saved.desktop.input, false);
    assert.equal((await post({ roots: [dataDir], capabilities: { write: 'yes' } })).status, 400);
    assert.equal((await post({ roots: [dataDir], capabilities: { write: true, commands: true, screenView: false, screenControl: true } })).status, 400);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
