import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const keyCodes: Record<string, number> = {
  a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4, i: 34, j: 38, k: 40, l: 37,
  m: 46, n: 45, o: 31, p: 35, q: 12, r: 15, s: 1, t: 17, u: 32, v: 9, w: 13,
  x: 7, y: 16, z: 6, '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23,
  '6': 22, '7': 26, '8': 28, '9': 25, return: 36, enter: 36, tab: 48, space: 49,
  backspace: 51, escape: 53, delete: 117, home: 115, end: 119, pageup: 116,
  pagedown: 121, left: 123, right: 124, down: 125, up: 126,
};

const modifierAliases: Record<string, string> = {
  super: 'command', meta: 'command', cmd: 'command', command: 'command',
  ctrl: 'control', control: 'control', alt: 'option', option: 'option', shift: 'shift',
};

export function requireMacDisplay(display: string): string {
  if (display !== 'main') throw new Error('On macOS, display must be "main".');
  return display;
}

export function parseMacKey(key: string): { keyCode: number; modifiers: string[] } {
  const parts = key.toLowerCase().split('+');
  const name = parts.pop() ?? '';
  const keyCode = keyCodes[name];
  if (keyCode === undefined) throw new Error(`Unsupported Mac key: ${key}`);
  const modifiers = parts.map(part => {
    const modifier = modifierAliases[part];
    if (modifier === undefined) throw new Error(`Unsupported Mac key: ${key}`);
    return modifier;
  });
  if (new Set(modifiers).size !== modifiers.length) {
    throw new Error(`Unsupported Mac key: ${key}`);
  }
  return { keyCode, modifiers };
}

const script = `
ObjC.import('ApplicationServices');
function run(argv) {
  const action = argv[0];
  if (!$.AXIsProcessTrusted()) throw Error('macOS Accessibility permission is required for desktop input.');
  const post = event => $.CGEventPost($.kCGHIDEventTap, event);
  const pointer = () => $.CGEventGetLocation($.CGEventCreate(null));
  const point = (x, y) => ({ x: Number(x), y: Number(y) });
  if (action === 'move') {
    post($.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, point(argv[1], argv[2]), $.kCGMouseButtonLeft));
  } else if (action === 'click') {
    const button = argv[1];
    const location = argv.length === 4 ? point(argv[2], argv[3]) : pointer();
    if (argv.length === 4) post($.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, location, $.kCGMouseButtonLeft));
    const types = button === 'right' ? [$.kCGEventRightMouseDown, $.kCGEventRightMouseUp, $.kCGMouseButtonRight]
      : button === 'middle' ? [$.kCGEventOtherMouseDown, $.kCGEventOtherMouseUp, $.kCGMouseButtonCenter]
      : [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp, $.kCGMouseButtonLeft];
    post($.CGEventCreateMouseEvent(null, types[0], location, types[2]));
    post($.CGEventCreateMouseEvent(null, types[1], location, types[2]));
  } else if (action === 'type') {
    const text = argv[1];
    const delayMs = Number(argv[2]);
    for (const character of Array.from(text)) {
      for (const down of [true, false]) {
        const event = $.CGEventCreateKeyboardEvent(null, 0, down);
        $.CGEventKeyboardSetUnicodeString(event, character.length, character);
        post(event);
      }
      if (delayMs) delay(delayMs / 1000);
    }
  } else if (action === 'key') {
    const code = Number(argv[1]);
    const modifiers = JSON.parse(argv[2]);
    let flags = 0;
    for (const modifier of modifiers) {
      flags |= modifier === 'command' ? $.kCGEventFlagMaskCommand
        : modifier === 'control' ? $.kCGEventFlagMaskControl
        : modifier === 'option' ? $.kCGEventFlagMaskAlternate
        : $.kCGEventFlagMaskShift;
    }
    for (const down of [true, false]) {
      const event = $.CGEventCreateKeyboardEvent(null, code, down);
      $.CGEventSetFlags(event, flags);
      post(event);
    }
  } else {
    throw Error('Unsupported Mac input action.');
  }
  return 'ok';
}`;

export async function macInput(action: 'move' | 'click' | 'type' | 'key', args: readonly string[]): Promise<void> {
  await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, action, ...args], {
    timeout: 30_000, maxBuffer: 64 * 1024,
  });
}

export async function macScreenSize(): Promise<{ width: number; height: number }> {
  const { stdout } = await exec('/usr/bin/osascript', [
    '-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); const size=$.NSScreen.mainScreen.frame.size; JSON.stringify({width:Math.round(size.width),height:Math.round(size.height)})',
  ], { timeout: 10_000, maxBuffer: 1024 });
  const size = JSON.parse(stdout.trim());
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width <= 0 || size.height <= 0) {
    throw new Error('Could not read the main Mac display size.');
  }
  return size;
}

export async function captureMacScreen(file: string): Promise<void> {
  await exec('/usr/sbin/screencapture', ['-x', '-m', '-t', 'png', file], { timeout: 30_000, maxBuffer: 64 * 1024 });
  const { width, height } = await macScreenSize();
  await exec('/usr/bin/sips', ['-z', String(height), String(width), file], { timeout: 30_000, maxBuffer: 64 * 1024 });
}
