import assert from 'node:assert/strict';
import test from 'node:test';
import * as core from './manager-core.mjs';

const { createReadOnlyConfig, isTunnelId, pollAgeSeconds, profileName } = core;

test('Mac access starts read-only and names tunnel profiles from generated IDs', () => {
  assert.equal(isTunnelId(`tunnel_${'a'.repeat(32)}`), true);
  assert.equal(isTunnelId(`tunnel_${'z'.repeat(32)}`), false);
  assert.equal(profileName('b261c9e0-65b0-4e54-958c-286668ce662f'), 'account-b261c9e0-65b0-4e54-958c-286668ce662f');
  const config = createReadOnlyConfig(['/Users/test/Projects']);
  assert.deepEqual(config.filesystem, { read: true, write: false, roots: ['/Users/test/Projects'] });
  assert.deepEqual(config.shell, { enabled: false });
  assert.deepEqual(config.http, { host: '127.0.0.1', port: 3210 });
});

test('tunnel freshness requires a recent successful poll', () => {
  assert.equal(pollAgeSeconds('commands_poll_last_successful_timestamp_seconds 100\n', 120), 20);
  assert.equal(pollAgeSeconds('commands_poll_last_successful_timestamp_seconds 100\n', 200), null);
  assert.equal(pollAgeSeconds('other_metric 100\n', 120), null);
});

test('explicit Mac grants enable writes, unrestricted commands, and separate screen access without unrelated capabilities', () => {
  assert.equal(typeof core.createAccessConfig, 'function');
  const config = core.createAccessConfig(['/Users/test/Projects'], { write: true, commands: true, screenView: true, screenControl: false });
  assert.deepEqual(config.filesystem, { read: true, write: true, roots: ['/Users/test/Projects'] });
  assert.deepEqual(config.shell, { enabled: true, allowedCommands: ['*'], allowEnvironment: false });
  assert.deepEqual(config.desktop, { hostDisplayAccess: true, screenCapture: true, input: false, screenRecording: false });
  assert.deepEqual(config.jobs, { enabled: false });
  assert.equal(config.process, undefined);
  assert.equal(config.service, undefined);
  assert.throws(() => core.createAccessConfig([], { screenView: false, screenControl: true }), /view/i);
});

test('Mac grants cannot enable file writes with no selected folder', () => {
  assert.equal(typeof core.createAccessConfig, 'function');
  assert.throws(() => core.createAccessConfig([], { write: true, commands: false, screenView: false, screenControl: false }), /folder/i);
});

test('editing shared grants preserves existing filesystem block rules', () => {
  const current = createReadOnlyConfig(['/Users/test/Projects']);
  current.filesystem.blocklist = [{ path: '/Users/test/Projects/private', mode: 'deny-read' }];
  current.http.token = 'private-test-token';
  current.http.allowedOrigins = ['https://allowed.example'];
  current.http.allowedHosts = ['allowed.example'];
  const next = core.createAccessConfig(current.filesystem.roots, { write: true, commands: false, screenView: false, screenControl: false }, current);
  assert.deepEqual(next.filesystem.blocklist, current.filesystem.blocklist);
  assert.deepEqual(next.http, current.http);
});
