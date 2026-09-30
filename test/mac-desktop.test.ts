import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import * as mac from '../src/adapter/mac-desktop.js';
import { LocalComputerAdapter } from '../src/adapter/local-computer-adapter.js';
import { parseConfig } from '../src/config.js';

test('Mac input accepts the main display and rejects X11 display names', () => {
  assert.equal(typeof mac.requireMacDisplay, 'function');
  assert.equal(mac.requireMacDisplay('main'), 'main');
  assert.throws(() => mac.requireMacDisplay(':0'), /main/);
});

test('Mac key input normalizes common shortcuts and rejects unsupported keys', () => {
  assert.equal(typeof mac.parseMacKey, 'function');
  assert.deepEqual(mac.parseMacKey('super+a'), { keyCode: 0, modifiers: ['command'] });
  assert.deepEqual(mac.parseMacKey('ctrl+shift+Return'), { keyCode: 36, modifiers: ['control', 'shift'] });
  assert.throws(() => mac.parseMacKey('totally-unknown'), /Unsupported/);
});

test('Mac adapter captures the main display and accepts pointer coordinates', { skip: process.platform !== 'darwin' }, async () => {
  const adapter = new LocalComputerAdapter(parseConfig({ desktop: { hostDisplayAccess: true, screenCapture: true, input: true } }));
  const capture = await adapter.captureScreen('main');
  assert.equal(capture.mimeType, 'image/png');
  assert.ok(capture.bytes > 1000);
  assert.deepEqual(Buffer.from(capture.data, 'base64').subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const point = JSON.parse(execFileSync('/usr/bin/osascript', [
    '-l', 'JavaScript', '-e', 'ObjC.import("ApplicationServices");const p=$.CGEventGetLocation($.CGEventCreate(null));JSON.stringify({x:Math.round(p.x),y:Math.round(p.y)})',
  ], { encoding: 'utf8' }));
  try {
    await adapter.movePointer(1, 1, 'main');
  } finally {
    await mac.macInput('move', [String(point.x), String(point.y)]);
  }
});
