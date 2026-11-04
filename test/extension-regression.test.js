import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createCommands } from '../extension/lib/commands.js';
import { DebuggerSession } from '../extension/lib/debugger.js';
import { pageRuntime } from '../extension/lib/page.js';

test('navigation, activation and close wait for ongoing tab input', async () => {
  for (const method of ['navigate', 'activate', 'close']) {
    let mutated = false;
    const chromeApi = {
      debugger: { async detach() {} },
      tabs: {
        async get(id) { return { id, windowId: 1, status: 'complete' }; },
        async update(id) { mutated = true; return { id }; },
        async remove() { mutated = true; },
      },
      windows: { async update() {} },
    };
    const session = new DebuggerSession({ chromeApi });
    const commands = createCommands({ chromeApi, session });
    let release;
    const input = session.exclusive(1, () => new Promise((resolve) => { release = resolve; }));
    await setImmediate();
    const change = commands[method]({ tabId: 1, url: 'https://example.test/' });
    await setImmediate();
    assert.equal(mutated, false, `${method} interrupted existing input`);
    release();
    await Promise.all([input, change]);
    assert.equal(mutated, true);
  }
});

test('selector click rejects an unrelated overlay or a disabled control', () => {
  const element = {
    nodeType: 1, hidden: false, disabled: false,
    getAttribute() { return null; },
    scrollIntoView() {},
    getBoundingClientRect() { return { left: 10, top: 10, width: 50, height: 20 }; },
    contains(other) { return other === this; },
  };
  const document = { querySelectorAll() { return [element]; }, elementFromPoint() { return {}; } };
  const context = { document, window: { innerWidth: 100, innerHeight: 100 }, getComputedStyle() { return {}; } };
  assert.match(pageRuntime(context, 'locate', { selector: '#button' }).error, /covered/);
  document.elementFromPoint = () => element;
  assert.equal(pageRuntime(context, 'locate', { selector: '#button' }).ok, true);
  element.disabled = true;
  assert.match(pageRuntime(context, 'locate', { selector: '#button' }).error, /disabled/);
});
