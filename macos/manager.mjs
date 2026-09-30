import { execFile } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { open, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bridgeStatus } from './bridge-status.mjs';
import { createAccessConfig, createReadOnlyConfig, isTunnelId, pollAgeSeconds, profileName } from './manager-core.mjs';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const dataHome = join(homedir(), 'Library', 'Application Support', 'ChatGPT Computer');
const backendLabel = 'com.luxiaolei.chatgpt-computer.backend';
const managerLabel = 'com.luxiaolei.chatgpt-computer.manager';
const managerPort = 3211;

function paths(dataDir) {
  return {
    dataDir, token: join(dataDir, 'manager-token'), config: join(dataDir, 'config.json'),
    accounts: join(dataDir, 'accounts.json'), secrets: join(dataDir, 'secrets'),
    profiles: join(dataDir, 'profiles'), logs: join(dataDir, 'logs'),
    agents: join(homedir(), 'Library', 'LaunchAgents'),
  };
}

async function ensureFile(path, content) {
  try {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(content); } finally { await file.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

async function setup(store) {
  for (const path of [store.dataDir, store.secrets, store.profiles, store.logs]) await mkdir(path, { recursive: true, mode: 0o700 });
  await ensureFile(store.token, randomBytes(32).toString('hex') + '\n');
  await ensureFile(store.config, JSON.stringify(createReadOnlyConfig([]), null, 2) + '\n');
  await ensureFile(store.accounts, '[]\n');
  return (await readFile(store.token, 'utf8')).trim();
}

async function saveJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

async function accounts(store) { return JSON.parse(await readFile(store.accounts, 'utf8')); }
async function config(store) { return JSON.parse(await readFile(store.config, 'utf8')); }

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function agentXML(label, arguments_, environment, logPath, workingDirectory) {
  const args = arguments_.map(value => `<string>${xml(value)}</string>`).join('');
  const vars = Object.entries(environment).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args}</array><key>EnvironmentVariables</key><dict>${vars}</dict><key>WorkingDirectory</key><string>${xml(workingDirectory)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>StandardOutPath</key><string>${xml(logPath)}</string><key>StandardErrorPath</key><string>${xml(logPath)}</string></dict></plist>\n`;
}

export function dashboardAgentPlist(runtimeDir, dataDir) {
  return agentXML(managerLabel, [join(runtimeDir, 'node'), join(runtimeDir, 'manager.mjs')], {},
    join(dataDir, 'logs', 'manager.log'), dataDir);
}

async function command(file, args, options = {}) {
  return exec(file, args, { timeout: 15_000, maxBuffer: 64 * 1024, ...options });
}

async function bridgeCommand(bridgeDirs, action, ...args) {
  if (bridgeDirs && !bridgeDirs.coordinatorPath) throw new Error('此环境尚未安装 Chat Bridge 协调服务。');
  const script = bridgeDirs?.coordinatorPath ?? join(homedir(), '.local', 'share', 'chatgpt-chat-bridge', 'coordinator.py');
  await stat(script);
  const python = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];
  let executable;
  for (const candidate of python) { try { await stat(candidate); executable = candidate; break; } catch { /* try next */ } }
  if (!executable) throw new Error('未找到 Python 3，无法保存 Bridge 配置。');
  const configDir = bridgeDirs?.configDir ?? join(homedir(), '.config', 'chat-bridge');
  const stateDir = bridgeDirs?.stateDir ?? join(homedir(), '.local', 'state', 'chat-bridge');
  try {
    const { stdout } = await command(executable, [script, action, configDir, stateDir, ...args], { timeout: 20_000, maxBuffer: 512 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    const detail = String(error.stderr ?? '');
    try { throw new Error(JSON.parse(detail).error || 'Chat Bridge 操作失败。'); }
    catch (parsed) { if (parsed instanceof SyntaxError) throw new Error('Chat Bridge 操作失败，请查看本机日志。'); throw parsed; }
  }
}

async function startAgent(store, label, plist) {
  await mkdir(store.agents, { recursive: true });
  const path = join(store.agents, `${label}.plist`);
  await writeFile(path, plist, { mode: 0o600 });
  const target = `gui/${process.getuid()}/${label}`;
  try { await command('/bin/launchctl', ['bootout', target]); } catch { /* not loaded */ }
  for (let attempt = 0; ; attempt++) {
    try { await command('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, path]); break; }
    catch (error) {
      if (error.code !== 5 || attempt === 19) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

async function stopAgent(label) {
  try { await command('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`]); }
  catch { /* already stopped */ }
  if (await agentLoaded(label)) throw new Error('无法停用连接，请检查 macOS 后台服务。');
}

async function agentLoaded(label) {
  try { await command('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]); return true; }
  catch { return false; }
}

async function startBackend(store, runtimeDir) {
  const node = join(runtimeDir, 'node');
  const server = join(runtimeDir, 'dist', 'src', 'http.js');
  await stat(node); await stat(server);
  const plist = agentXML(backendLabel, [node, server], { CHATGPT_MCP_CONFIG: store.config },
    join(store.logs, 'backend.log'), store.dataDir);
  await startAgent(store, backendLabel, plist);
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await probe('http://127.0.0.1:3210/healthz'))?.ok) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('本机服务没有正常启动，请检查后台日志。');
}

async function freeHealthPort(used) {
  const { createServer: tcpServer } = await import('node:net');
  for (let port = 8180; port <= 8279; port++) {
    if (used.has(port)) continue;
    const server = tcpServer();
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      await new Promise(resolve => server.close(resolve));
      return port;
    } catch { try { server.close(); } catch {} }
  }
  throw new Error('No free tunnel health port');
}

function accountLabel(id) { return `com.luxiaolei.chatgpt-computer.${profileName(id)}`; }

async function startAccount(store, runtimeDir, account) {
  const launcher = join(runtimeDir, 'run-tunnel.sh');
  const binary = join(runtimeDir, 'tunnel-client');
  const secret = join(store.secrets, `${account.id}.key`);
  await stat(launcher); await stat(binary); await stat(secret);
  const label = accountLabel(account.id);
  const plist = agentXML(label, [launcher, secret, store.profiles, binary, profileName(account.id), account.accountId || encodeURIComponent(account.label)], {},
    join(store.logs, `${profileName(account.id)}.log`), store.dataDir);
  await startAgent(store, label, plist);
}

async function addAccount(store, runtimeDir, input) {
  const label = String(input.label ?? '').trim();
  const tunnelId = String(input.tunnelId ?? '').trim();
  const apiKey = String(input.apiKey ?? '').trim();
  if (!label || label.length > 64 || !isTunnelId(tunnelId) || !apiKey.startsWith('sk-') || apiKey.length > 1024) {
    throw new Error('请填写账号名称、有效的隧道 ID 和运行 API Key。');
  }
  const existing = await accounts(store);
  if (existing.some(item => item.tunnelId === tunnelId)) throw new Error('这个隧道已经添加。');
  const account = { id: randomUUID(), label, tunnelId, healthPort: await freeHealthPort(new Set(existing.map(item => item.healthPort))), enabled: false };
  const secret = join(store.secrets, `${account.id}.key`);
  await ensureFile(secret, apiKey + '\n');
  try {
    await command(join(runtimeDir, 'tunnel-client'), [
      'init', '--sample', 'sample_mcp_remote_no_auth', '--profile', profileName(account.id),
      '--profile-dir', store.profiles, '--tunnel-id', tunnelId,
      '--health-listen-addr', `127.0.0.1:${account.healthPort}`,
      '--mcp-server-url', 'http://127.0.0.1:3210/mcp',
    ], { env: { ...process.env, CONTROL_PLANE_API_KEY: apiKey } });
  } catch {
    await rm(secret, { force: true });
    throw new Error('隧道配置失败；请检查 ID 和本机运行组件。');
  }
  existing.push(account);
  await saveJSON(store.accounts, existing);
  return account;
}

async function probe(url, headers = {}) {
  try { return await fetch(url, { headers, signal: AbortSignal.timeout(1500) }); }
  catch { return null; }
}

async function status(store) {
  const current = await accounts(store);
  const access = await config(store);
  const backend = await probe('http://127.0.0.1:3210/healthz');
  const metrics = await probe('http://127.0.0.1:3210/metrics', access.http?.token ? { Authorization: `Bearer ${access.http.token}` } : {});
  let toolResults = {};
  try { if (metrics?.ok) toolResults = (await metrics.json()).originToolResults || {}; } catch { /* unknown, not a successful tool result */ }
  const connections = await Promise.all(current.map(async account => {
    const lastToolResult = toolResults[account.accountId] || null;
    if (!account.enabled) return { ...account, state: 'stopped', lastToolResult };
    const response = await probe(`http://127.0.0.1:${account.healthPort}/metrics`);
    const age = response?.ok ? pollAgeSeconds(await response.text()) : null;
    const loaded = await agentLoaded(accountLabel(account.id));
    return { ...account, state: age === null || !loaded ? 'offline' : 'online', pollAgeSeconds: age, lastToolResult };
  }));
  return {
    backend: backend?.ok && await agentLoaded(backendLabel) ? 'online' : 'offline',
    roots: access.filesystem?.roots ?? [],
    capabilities: {
      write: access.filesystem?.write === true,
      commands: access.shell?.enabled === true && access.shell.allowedCommands?.includes('*') === true,
      screenView: access.desktop?.hostDisplayAccess === true && access.desktop.screenCapture === true,
      screenControl: access.desktop?.hostDisplayAccess === true && access.desktop.input === true,
    },
    accounts: connections,
  };
}

function sameSecret(a, b) {
  const left = Buffer.from(a ?? ''); const right = Buffer.from(b ?? '');
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookie(req) {
  return (req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith('manager='))?.slice(8);
}

function reply(res, code, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function inputJSON(req) {
  if (req.headers['content-type'] !== 'application/json') throw new Error('需要 JSON 请求。');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_384) throw new Error('请求过大。');
  }
  return JSON.parse(body || '{}');
}

export async function createManagerServer({ dataDir = dataHome, port = managerPort, runtimeDir = here, bridgeDirs } = {}) {
  const store = paths(dataDir);
  const token = await setup(store);
  let mutation = Promise.resolve();
  const server = createServer(async (req, res) => {
    const expectedOrigin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) return reply(res, 403, { error: 'Invalid host' });
    const url = new URL(req.url ?? '/', expectedOrigin);
    if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { app: 'chatgpt-computer-manager' });
    if (url.pathname === '/' && sameSecret(url.searchParams.get('token'), token)) {
      return reply(res, 303, '', 'text/plain; charset=utf-8', {
        Location: '/', 'Set-Cookie': `manager=${token}; HttpOnly; SameSite=Strict; Max-Age=604800; Path=/`,
      });
    }
    if (!sameSecret(cookie(req), token)) return reply(res, 401, { error: '请从 Mac 应用打开管理页。' });
    if (req.method === 'POST' && req.headers.origin !== expectedOrigin) return reply(res, 403, { error: 'Invalid origin' });
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        const html = await readFile(join(runtimeDir, 'manager.html'), 'utf8');
        return reply(res, 200, html, 'text/html; charset=utf-8', { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" });
      }
      if (req.method === 'GET' && url.pathname === '/api/status') return reply(res, 200, await status(store));
      if (req.method === 'GET' && url.pathname === '/api/bridge') {
        const bridge = await bridgeStatus(bridgeDirs);
        try { bridge.queue = await bridgeCommand(bridgeDirs, 'list'); }
        catch { bridge.queue = { unavailable: true, operations: [] }; }
        try { bridge.control = await bridgeCommand(bridgeDirs, 'control', 'status'); }
        catch { bridge.control = { unavailable: true, projects: [] }; }
        return reply(res, 200, bridge);
      }
      if (req.method !== 'POST') return reply(res, 404, { error: 'Not found' });
      const input = await inputJSON(req);
      const work = async () => {
        if (url.pathname === '/api/backend/start') { await startBackend(store, runtimeDir); return { ok: true }; }
        if (url.pathname === '/api/backend/ensure') {
          if (!await agentLoaded(backendLabel) || !(await probe('http://127.0.0.1:3210/healthz'))?.ok) await startBackend(store, runtimeDir);
          return { ok: true };
        }
        if (url.pathname === '/api/folder/pick') {
          const { stdout } = await command('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "允许 ChatGPT 读取哪个文件夹？")']);
          return { path: stdout.trim().replace(/\/$/, '') };
        }
        if (url.pathname === '/api/config') {
          if (!Array.isArray(input.roots) || input.roots.length > 8) throw new Error('最多选择 8 个文件夹。');
          const roots = [];
          for (const item of input.roots) {
            if (typeof item !== 'string' || !item.startsWith('/')) throw new Error('请选择绝对路径的文件夹。');
            const resolved = await realpath(item);
            if (!(await stat(resolved)).isDirectory()) throw new Error('路径不是文件夹。');
            if (!roots.includes(resolved)) roots.push(resolved);
          }
          const current = await config(store);
          const flags = input.capabilities;
          if (flags !== undefined && (flags === null || typeof flags !== 'object' || Array.isArray(flags) ||
            ['write', 'commands', 'screenView', 'screenControl'].some(key => typeof flags[key] !== 'boolean'))) {
            throw new Error('权限设置必须是四个明确的开关。');
          }
          const next = flags === undefined
            ? { ...current, filesystem: { ...current.filesystem, roots, read: roots.length > 0 } }
            : createAccessConfig(roots, flags, current);
          await saveJSON(store.config, next);
          return { ok: true, restartRequired: true };
        }
        if (url.pathname === '/api/account') return { account: await addAccount(store, runtimeDir, input) };
        if (url.pathname === '/api/bridge/config') return await bridgeCommand(bridgeDirs, 'configure', JSON.stringify(input));
        const operation = url.pathname.match(/^\/api\/bridge\/operation\/([0-9a-f-]{36})\/cancel$/);
        if (operation) return await bridgeCommand(bridgeDirs, 'cancel', operation[1]);
        const match = url.pathname.match(/^\/api\/account\/([0-9a-f-]+)\/(start|stop|update)$/);
        if (match) {
          const list = await accounts(store);
          const account = list.find(item => item.id === match[1]);
          if (!account) throw new Error('找不到这个账号。');
          if (match[2] === 'update') {
            const label = String(input.label ?? '').trim();
            if (!label || label.length > 64) throw new Error('账号名称不能为空，且最多 64 个字符。');
            if (!/^[0-9a-f]{64}$/.test(input.accountId ?? '')) throw new Error('请选择已核实的 ChatGPT 账号。');
            const bridge = await bridgeStatus(bridgeDirs);
            if (!bridge.accounts.some(item => item.id === input.accountId && item.identified)) throw new Error('这个 ChatGPT 登录身份尚未核实。');
            account.label = label;
            account.accountId = input.accountId;
            if (account.enabled) await startAccount(store, runtimeDir, account);
          } else {
            if (match[2] === 'start') await startAccount(store, runtimeDir, account);
            else await stopAgent(accountLabel(account.id));
            account.enabled = match[2] === 'start';
          }
          await saveJSON(store.accounts, list);
          return { ok: true };
        }
        throw new Error('Unknown action');
      };
      const next = mutation.catch(() => {}).then(work);
      mutation = next;
      return reply(res, 200, await next);
    } catch (error) {
      return reply(res, 400, { error: error.message === 'Unexpected end of JSON input' ? '请求格式错误。' : error.message });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, token };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--install-dashboard') {
    const store = paths(dataHome);
    await setup(store);
    await startAgent(store, managerLabel, dashboardAgentPlist(here, dataHome));
    process.stdout.write('Local dashboard installed at http://127.0.0.1:3211/\n');
  } else {
    const { server } = await createManagerServer();
    process.stderr.write(`ChatGPT Computer manager at http://127.0.0.1:${server.address().port}\n`);
  }
}
