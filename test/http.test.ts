import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { LocalComputerAdapter } from '../src/adapter/local-computer-adapter.js';
import { ConcurrencyController } from '../src/concurrency.js';
import { parseConfig } from '../src/config.js';
import { createComputerHttpServer } from '../src/http-server.js';
import { decodeRpc } from '../src/hotswap/sse.js';

async function withServer(
  configValue: unknown,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const config = parseConfig(configValue);
  const { server, closeHandler } = createComputerHttpServer(config);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await closeHandler();
  }
}

test('health endpoint is available without MCP bearer token', async () => {
  await withServer({ http: { token: 'secret' } }, async baseUrl => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: '@platform-modules/chatgpt-mcp' });
  });
});

test('MCP endpoint enforces configured bearer token', async () => {
  await withServer({ http: { token: 'secret' } }, async baseUrl => {
    const denied = await fetch(`${baseUrl}/mcp`, { method: 'POST' });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('www-authenticate'), 'Bearer');

    const wrong = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer nope' },
    });
    assert.equal(wrong.status, 401);

    const admitted = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: { Authorization: 'Bearer secret' },
    });
    assert.notEqual(admitted.status, 401);
    const publicMetrics = await (await fetch(`${baseUrl}/metrics`)).json();
    assert.equal('originToolResults' in publicMetrics, false);
    const privateMetrics = await (await fetch(`${baseUrl}/metrics`, { headers: { Authorization: 'Bearer secret' } })).json();
    assert.equal(typeof privateMetrics.originToolResults, 'object');
  });
});

test('MCP tunnel origin Space is available to its shell call without leaking to another call', async () => {
  await withServer({ shell: { enabled: true, allowedCommands: ['node'] } }, async baseUrl => {
    const call = async (origin?: string) => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          ...(origin ? { 'x-chat-bridge-origin-space': encodeURIComponent(origin) } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'shell.exec', arguments: { command: 'node', args: ['-e', 'process.stdout.write(process.env.CHAT_BRIDGE_FROM_SPACE || "")'] },
        } }),
      });
      assert.equal(response.status, 200);
      const body = decodeRpc(new Uint8Array(await response.arrayBuffer()), response.headers.get('content-type') ?? undefined) as { result: { structuredContent: { stdout: string } } };
      return body.result.structuredContent.stdout;
    };
    assert.equal(await call('QC2- Agent'), 'QC2- Agent');
    assert.equal(await call(), '');
  });
});

test('stable account origin is isolated to its MCP request', async () => {
  await withServer({ shell: { enabled: true, allowedCommands: ['node'] } }, async baseUrl => {
    const call = async (account?: string) => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          ...(account ? { 'x-chat-bridge-origin-account': account } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'shell.exec', arguments: { command: 'node', args: ['-e', 'process.stdout.write(process.env.CHAT_BRIDGE_FROM_ACCOUNT_ID || "")'] },
        } }),
      });
      if (response.status !== 200) return { status: response.status };
      const body = decodeRpc(new Uint8Array(await response.arrayBuffer()), response.headers.get('content-type') ?? undefined) as { result: { structuredContent: { stdout: string } } };
      return { status: 200, stdout: body.result.structuredContent.stdout };
    };
    assert.deepEqual(await call('a'.repeat(64)), { status: 200, stdout: 'a'.repeat(64) });
    assert.deepEqual(await call(), { status: 200, stdout: '' });
    assert.deepEqual(await call('bad'), { status: 400 });
    assert.deepEqual(await Promise.all([call('b'.repeat(64)), call('c'.repeat(64)), call()]), [
      { status: 200, stdout: 'b'.repeat(64) }, { status: 200, stdout: 'c'.repeat(64) }, { status: 200, stdout: '' },
    ]);
    const metrics = await (await fetch(`${baseUrl}/metrics`)).json();
    assert.equal(metrics.originToolResults['b'.repeat(64)].operation, 'shell.exec');
    assert.equal(metrics.originToolResults['c'.repeat(64)].status, 'RETURNED');
    assert.equal(typeof metrics.originToolResults['b'.repeat(64)].observedAt, 'string');
    assert.equal(JSON.stringify(metrics.originToolResults).includes('stdout'), false);
  });
});

test('localhost origin validation rejects a foreign browser origin', async () => {
  await withServer({}, async baseUrl => {
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(response.status, 403);
  });
});

test('unknown routes do not fall through to MCP', async () => {
  await withServer({}, async baseUrl => {
    const response = await fetch(`${baseUrl}/anything-else`);
    assert.equal(response.status, 404);
  });
});

test('non-loopback bind requires explicit allowed hosts', () => {
  const config = parseConfig({ http: { host: '0.0.0.0' } });
  assert.throws(() => createComputerHttpServer(config), /allowedHosts/);
});


test('readiness and metrics expose admission capacity without changing liveness', async () => {
  const config = parseConfig({
    concurrency: { maxConcurrent: 2, reservedControlSlots: 1, shellMaxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 1_000 },
  });
  const concurrency = new ConcurrencyController(config.concurrency);
  const { server, closeHandler } = createComputerHttpServer(config, new LocalComputerAdapter(config), concurrency);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const active = concurrency.run('fs.read.active', async () => blocker);
  const queued = concurrency.run('fs.read.queued', async () => undefined);
  await new Promise<void>(resolve => setImmediate(resolve));
  try {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: '@platform-modules/chatgpt-mcp' });

    const ready = await fetch(`${baseUrl}/readyz`);
    assert.equal(ready.status, 503);
    const readyBody = await ready.json() as { ok: boolean; concurrency: { status: string; queued: { total: number } } };
    assert.equal(readyBody.ok, false);
    assert.equal(readyBody.concurrency.status, 'overloaded');
    assert.equal(readyBody.concurrency.queued.total, 1);

    const metrics = await fetch(`${baseUrl}/metrics`);
    assert.equal(metrics.status, 200);
    const metricsBody = await metrics.json() as { concurrency: { limits: { maxQueue: number }; active: { total: number }; queued: { total: number } } };
    assert.equal(metricsBody.concurrency.limits.maxQueue, 1);
    assert.equal(metricsBody.concurrency.active.total, 1);
    assert.equal(metricsBody.concurrency.queued.total, 1);
  } finally {
    release();
    await Promise.all([active, queued]);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await closeHandler();
  }
});
