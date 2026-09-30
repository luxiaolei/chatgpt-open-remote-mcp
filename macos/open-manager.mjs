import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const base = 'http://127.0.0.1:3211';
const tokenPath = join(homedir(), 'Library', 'Application Support', 'ChatGPT Computer', 'manager-token');

async function ready() {
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
    return response.ok && (await response.json()).app === 'chatgpt-computer-manager';
  } catch { return false; }
}

if (!await ready()) {
  const child = spawn(process.execPath, [join(here, 'manager.mjs')], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let attempt = 0; attempt < 30 && !await ready(); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
}
if (!await ready()) throw new Error('Cannot start the local manager; port 3211 may be occupied.');
const token = (await readFile(tokenPath, 'utf8')).trim();
process.stdout.write(`${base}/?token=${token}\n`);
