import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

test('dashboard script compiles and exposes project-first accessible views', async () => {
  const html = await readFile(new URL('./manager.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  for (const name of ['projects', 'accounts', 'settings']) {
    assert.match(html, new RegExp(`id="tab-${name}"[^>]*role="tab"`));
  }
  assert.match(html, /id="queue-operations"/);
  assert.match(html, /id="bridge-summary"/);
  assert.match(html, /id="bridge-project-table"/);
  assert.match(html, /id="bridge-spaces"/);
  assert.match(html, /state-chip/);
  assert.match(html, /id="project-add"/);
  const nodes = new Map();
  let focused = null;
  const context = { currentView: 'projects', $: id => {
    if (!nodes.has(id)) nodes.set(id, { attributes: {}, setAttribute(key, value) { this.attributes[key] = value; }, focus() { focused = id; } });
    return nodes.get(id);
  } };
  runInNewContext(script.slice(script.indexOf('function showView(view)'), script.indexOf('function message(')), context);
  let prevented = false;
  context.$('tab-projects').onkeydown({ key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(context.currentView, 'accounts');
  assert.equal(focused, 'tab-accounts');
  assert.equal(context.$('tab-accounts').attributes['aria-selected'], 'true');
  context.$('tab-accounts').onkeydown({ key: 'End', preventDefault() {} });
  assert.equal(context.currentView, 'settings');
  context.$('tab-settings').onkeydown({ key: 'Home', preventDefault() {} });
  assert.equal(context.currentView, 'projects');
});
