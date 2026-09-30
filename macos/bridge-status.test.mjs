import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bridgeStatus } from './bridge-status.mjs';
import { createHash } from 'node:crypto';

test('dashboard exposes a safe local Bridge summary without browser or secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-bridge-status-'));
  const configDir = join(dir, 'config');
  const stateDir = join(dir, 'state');
  await mkdir(configDir); await mkdir(stateDir);
  try {
    assert.deepEqual(await bridgeStatus({ configDir, stateDir }), { available: false, accounts: [], projects: [], spaces: [], discoveredProjects: [] });
    await writeFile(join(configDir, 'registry.json'), JSON.stringify({
      accounts: { personal: { label: '个人', identity: 'secret-user-id', identifiedAt: '2026-09-25' } },
      projects: { '项目 A': { activeAccount: 'personal', bindings: { personal: { projectUrl: 'https://private.example/project' } } } },
      chats: { one: { project: '项目 A', account: 'personal', status: 'active', url: 'https://private.example/chat' }, two: { project: '项目 A', account: 'personal', status: 'retired' } },
    }));
    await writeFile(join(stateDir, 'runtime.json'), JSON.stringify({ tasks: {
      current: { project: '项目 A', account: 'personal', status: 'RUNNING', originalMessage: 'private prompt', taskId: 'A-1' },
      done: { project: '项目 A', account: 'personal', status: 'COMPLETE', originalMessage: 'secret' },
      blocked: { project: '项目 A', account: 'personal', status: 'BLOCKED', taskId: 'A-blocked' },
      recorded: { project: '项目 A', account: 'personal', status: 'RESULT_RECORDED', taskId: 'A-recorded' },
    } }));
    const result = await bridgeStatus({ configDir, stateDir });
    assert.deepEqual(result, {
      available: true,
      accounts: [{ id: createHash('sha256').update('identity:secret-user-id').digest('hex'), aliases: ['personal'], label: '个人', identified: true }],
      projects: [{ name: '项目 A', key: '项目 A', displayName: '项目 A', account: 'personal', accountNames: ['个人'], allowedAccounts: ['personal'], archived: false,
        bindings: [{ account: 'personal', accountName: '个人', projectId: null, spaceName: null, spaceDisplayName: null, profileId: null, ready: true }],
        spaceNames: [], spaceDisplayNames: [], workgroups: [],
        controllerChats: [{ sessionRef: 'one', role: 'one', account: 'personal' }],
        sessions: 1, activeTasks: 1, taskStates: [{ status: 'RUNNING', count: 1 }] }],
      spaces: [],
      discoveredProjects: [],
    });
    assert.doesNotMatch(JSON.stringify(result), /secret|private\.example|A-1/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('dashboard merges aliases of one login and uses observed ChatGPT account name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-bridge-identity-'));
  const configDir = join(dir, 'config'); const stateDir = join(dir, 'state');
  await mkdir(configDir); await mkdir(stateDir);
  try {
    await writeFile(join(configDir, 'registry.json'), JSON.stringify({
      accounts: { default: { identity: 'user-one', label: 'Old Space' }, alias: { identity: 'user-one', label: 'Another Space' } },
      spaces: { Manual: { name: 'QC, Social - Manual', identity: 'user-one', accountName: 'Real Name', observedAt: '2026-09-25T12:00:00Z', projects: [{ id: 'g-p-' + 'a'.repeat(32) }] } },
      projects: { '业务 A': { bindings: { default: { projectId: 'g-p-' + 'a'.repeat(32) + '-business' } } } }, chats: {},
    }));
    const result = await bridgeStatus({ configDir, stateDir });
    assert.deepEqual(result.accounts, [{ id: createHash('sha256').update('identity:user-one').digest('hex'), aliases: ['default', 'alias'], label: 'Real Name', identified: true }]);
    assert.equal(result.spaces[0].displayName, '手动 · Real Name · QC, Social Manual');
    assert.equal(result.spaces[0].name, 'QC, Social - Manual');
    assert.deepEqual(result.spaces[0].projectNames, ['业务 A']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a copied Project binding is not ready when that login has a different observed catalog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-bridge-binding-'));
  const configDir = join(dir, 'config'); const stateDir = join(dir, 'state');
  await mkdir(configDir); await mkdir(stateDir);
  try {
    await writeFile(join(configDir, 'registry.json'), JSON.stringify({
      accounts: { hz: { identity: 'hzcodex' } },
      spaces: { QC: { identity: 'hzcodex', account: 'hz', projects: [{ id: 'g-p-' + 'b'.repeat(32) }] } },
      projects: { 'HZ OS': { bindings: { hz: { projectId: 'g-p-' + 'a'.repeat(32), projectUrl: 'https://chatgpt.com/g/g-p-' + 'a'.repeat(32) + '/project' } } } },
    }));
    const result = await bridgeStatus({ configDir, stateDir });
    assert.equal(result.projects[0].bindings[0].ready, false);
    const matching = { accounts: { hz: { identity: 'hzcodex' } },
      spaces: { QC: { identity: 'hzcodex', account: 'hz', projects: [{ id: 'g-p-' + 'a'.repeat(32) }] } },
      projects: { 'HZ OS': { bindings: { hz: { projectId: 'g-p-' + 'a'.repeat(32) + '-hz-os', projectUrl: 'https://chatgpt.com/g/g-p-' + 'a'.repeat(32) + '-hz-os/project' } } } } };
    await writeFile(join(configDir, 'registry.json'), JSON.stringify(matching));
    assert.equal((await bridgeStatus({ configDir, stateDir })).projects[0].bindings[0].ready, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
