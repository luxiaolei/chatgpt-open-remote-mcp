import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function readJSON(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function bridgeStatus({
  configDir = join(homedir(), '.config', 'chat-bridge'),
  stateDir = join(homedir(), '.local', 'state', 'chat-bridge'),
} = {}) {
  const registry = await readJSON(join(configDir, 'registry.json'));
  if (!registry) return { available: false, accounts: [], projects: [], spaces: [], discoveredProjects: [] };
  const runtime = await readJSON(join(stateDir, 'runtime.json'));
  const chats = Object.values(registry.chats ?? {});
  const tasks = Object.values(runtime?.tasks ?? {});
  const terminal = new Set(['COMPLETE', 'FAILED', 'CANCELLED', 'BLOCKED', 'RESULT_RECORDED']);
  const accounts = new Map();
  for (const [alias, account] of Object.entries(registry.accounts ?? {})) {
    const id = account.identity ? createHash('sha256').update(`identity:${account.identity}`).digest('hex') : null;
    const key = id ?? `unverified:${alias}`;
    const current = accounts.get(key) ?? { id, aliases: [], label: account.label || alias, identified: false };
    current.aliases.push(alias);
    current.identified ||= Boolean(account.identity && account.identifiedAt);
    if (account.shortName) current.shortName = account.shortName;
    if (account.acceptNewTasks === false) current.acceptNewTasks = false;
    if (Number.isInteger(account.maxActiveTasks)) current.maxActiveTasks = account.maxActiveTasks;
    accounts.set(key, current);
  }
  for (const space of Object.values(registry.spaces ?? {})) {
    if (!space.identity || !space.accountName) continue;
    const id = createHash('sha256').update(`identity:${space.identity}`).digest('hex');
    const current = accounts.get(id);
    if (current) { current.label = space.accountName; current.identified = true; }
  }
  const projectNameById = new Map();
  const canonicalProjectId = value => String(value || '').match(/g-p-[0-9a-f]{32}/i)?.[0].toLowerCase() || null;
  for (const [projectName, project] of Object.entries(registry.projects || {})) {
    for (const binding of Object.values(project.bindings || {})) {
      const id = binding.projectId || String(binding.projectUrl || '').match(/\/g\/(g-p-[^/]+)/)?.[1];
      if (id) { projectNameById.set(id, project.name || projectName); if (canonicalProjectId(id)) projectNameById.set(canonicalProjectId(id), project.name || projectName); }
    }
  }
  const spaces = Object.values(registry.spaces || {}).map((space, index) => {
    const account = space.account || registry.defaultAccount || 'default';
    const accountName = space.accountName || registry.accounts?.[account]?.shortName || registry.accounts?.[account]?.label || account;
    const managed = space.ownership === 'agent';
    const profile = space.profileId ? ` · ${space.profileId}` : '';
    const tidy = String(space.name || `Space ${index + 1}`).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      name: space.name,
      displayName: managed ? `Bridge · ${accountName}${profile} · ${tidy}` : `手动 · ${accountName} · ${tidy}`,
      account,
      accountName,
      ownership: space.ownership || 'unconfirmed',
      profileId: space.profileId || null,
      observedAt: space.observedAt || null,
      projectNames: [...new Set((space.projects || []).map(project => {
        const name = project.name || project.id;
        const resolved = projectNameById.get(project.id) || projectNameById.get(canonicalProjectId(project.id)) || projectNameById.get(name);
        return resolved || (canonicalProjectId(name) ? `未登记 Project · ${canonicalProjectId(name)}` : name);
      }).filter(Boolean))],
    };
  });
  const spaceByName = new Map(spaces.map(space => [space.name, space]));
  const accountName = alias => {
    const observed = spaces.find(space => space.account === alias && space.accountName);
    return observed?.accountName || registry.accounts?.[alias]?.shortName || registry.accounts?.[alias]?.label || alias;
  };
  const displaySpace = (name, alias) => spaceByName.get(name)?.displayName || (name ? `Bridge 配置 · ${accountName(alias)} · ${String(name).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()}` : null);
  const bindingReady = (alias, binding) => {
    const identity = registry.accounts?.[alias]?.identity;
    if (!identity || !binding.projectUrl) return false;
    const observed = Object.values(registry.spaces ?? {}).filter(space => space.identity === identity)
      .flatMap(space => space.projects ?? []).map(project => project.id);
    if (!observed.length) return true;
    const projectId = binding.projectId || binding.projectUrl.match(/\/g\/(g-p-[^/]+)/)?.[1];
    const canonical = value => String(value ?? '').match(/g-p-[0-9a-f]{32}/)?.[0] ?? null;
    return canonical(projectId) !== null && observed.some(value => canonical(value) === canonical(projectId));
  };
  return {
    available: true,
    accounts: [...accounts.values()],
    projects: Object.entries(registry.projects ?? {}).map(([name, project]) => {
      const open = tasks.filter(task => task.project === name && !terminal.has(String(task.status || '').toUpperCase()));
      const counts = {};
      for (const task of open) {
        const status = ['DISPATCHED', 'RUNNING', 'RECOVERING', 'AWAITING_DURABLE_UPDATE', 'BLOCKED'].includes(task.status) ? task.status : 'OTHER';
        counts[status] = (counts[status] ?? 0) + 1;
      }
      return {
        name, key: name, displayName: project.name || name,
        account: project.activeAccount ?? registry.defaultAccount ?? 'default',
        accountNames: [...new Set(Object.keys(project.bindings || {}).map(accountName))],
        allowedAccounts: project.allowedAccounts || Object.keys(project.bindings || {}),
        archived: project.archived === true,
        bindings: Object.entries(project.bindings || {}).map(([alias, binding]) => ({
          account: alias, accountName: accountName(alias), projectId: binding.projectId || null, spaceName: binding.spaceName || null,
          spaceDisplayName: displaySpace(binding.spaceName, alias),
          profileId: binding.profileId || null, ready: bindingReady(alias, binding),
        })),
        spaceNames: [...new Set(Object.values(project.bindings || {}).map(binding => binding.spaceName).filter(Boolean))],
        spaceDisplayNames: [...new Set(Object.entries(project.bindings || {}).map(([alias, binding]) => displaySpace(binding.spaceName, alias)).filter(Boolean))],
        workgroups: Object.entries(project.workgroups || {}).map(([id, group]) => ({ id, name: group.name || id,
          controllerSessionRef: group.controllerSessionRef || null })),
        controllerChats: Object.entries(registry.chats || {}).filter(([, chat]) => chat.project === name && chat.status === 'active').map(([id, chat]) => ({
          sessionRef: chat.id || id, role: chat.role || chat.name || chat.id || id, account: chat.account,
        })),
        sessions: chats.filter(chat => chat.project === name && chat.status === 'active').length,
        activeTasks: open.length,
        taskStates: Object.entries(counts).map(([status, count]) => ({ status, count })),
      };
    }),
    spaces,
    discoveredProjects: Object.values(registry.spaces || {}).flatMap(space => (space.projects || []).map(project => ({
      projectId: project.id, name: project.name || project.id, account: space.account, profileId: space.profileId || null,
      spaceName: space.name,
    }))),
  };
}
