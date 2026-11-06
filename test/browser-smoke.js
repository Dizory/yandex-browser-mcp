import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const html = await readFile(new URL('./fixture.html', import.meta.url));
const fixture = createServer((req, res) => {
  if (req.url === '/yandex-mcp-fixture.txt') {
    res.writeHead(200, { 'Content-Disposition': 'attachment; filename="yandex-mcp-fixture.txt"', 'Content-Type': 'text/plain' }).end('fixture');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const client = new Client({ name: 'browser-smoke-test', version: '1.0.0' });
let tabId;
let originalTab;
async function call(method, args = {}) {
  const result = await client.callTool({ name: `browser_${method}`, arguments: args });
  assert.notEqual(result.isError, true, result.content[0]?.text);
  return result.content[0].type === 'text' ? JSON.parse(result.content[0].text) : result.content[0];
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.BROWSER_TEST_MCP_URL || 'http://127.0.0.1:37891/mcp')));
  const tabs = await call('tabs');
  originalTab = tabs.find((tab) => tab.active)?.id;
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  tabId = (await call('open', { url })).id;
  assert.ok(Number.isInteger(tabId));
  await call('activate', { tabId });
  assert.equal((await call('wait', { tabId, selector: '#person' })).matched, true);
  let snapshot;
  for (let attempt = 0; attempt < 20; attempt++) {
    snapshot = await call('snapshot', { tabId });
    if (snapshot.text.includes('Проверка управления')) break;
    await delay(250);
  }
  assert.match(snapshot.text, /Проверка управления/);
  assert.ok(!JSON.stringify(snapshot).includes('fixture-secret-not-real'), 'Snapshot leaked password input value');
  assert.ok(snapshot.elements.some((element) => element.selector === '#message'));
  const base = await call('diff', { tabId });
  assert.ok(base.snapshotId);
  assert.match(JSON.stringify(await call('read_table', { tabId, selector: 'table' })), /Название/);
  assert.match(JSON.stringify(await call('read_region', { tabId, selector: '#details' })), /Черновик/);
  const form = await call('read_form', { tabId, selector: '#details' });
  assert.match(JSON.stringify(form), /#person/);
  assert.match(JSON.stringify(form), /"invalid":true/);
  assert.equal((await call('wait', { tabId, selector: '#stage', state: 'enabled' })).matched, true);
  assert.equal((await call('inspect', { tabId, selector: '#person' })).mode, 'element');
  await call('fill_form', { tabId, fields: [{ selector: '#person', value: 'Дмитрий' }] });
  await call('select', { tabId, selector: '#stage', labels: ['Готово'] });
  await call('set_checked', { tabId, selector: '#flag', checked: true });
  await call('set_checked', { tabId, selector: '#flag', checked: true });
  await call('upload_file', { tabId, selector: '#attach', paths: [fileURLToPath(new URL('./fixture.html', import.meta.url))] });
  assert.deepEqual(await call('evaluate', { tabId, expression: '[person.value, stage.value, flag.checked, attach.files[0].name]' }),
    ['Дмитрий', 'Готово', true, 'fixture.html']);
  const frame = (await call('frames', { tabId })).frames.find(item => item.parentFrameId);
  assert.ok(frame, 'Fixture iframe missing');
  const scoped = await call('snapshot', { tabId, frameId: frame.frameId });
  assert.ok(scoped.elements.some(el => el.selector === '#branch'));
  await call('fill_form', { tabId, frameId: frame.frameId, fields: [{ selector: '#branch', value: 'Урал' }] });
  assert.equal((await call('find', { tabId, frameId: frame.frameId, name: 'Филиал', role: 'textbox' })).elements[0].selector, '#branch');
  assert.ok((await call('snapshot', { tabId, frameId: frame.frameId })).elements.some(el => el.value === 'Урал'));
  await call('hover', { tabId, selector: '#handle' });
  await call('drag', { tabId, from: { selector: '#handle' }, to: { selector: '#target' } });
  assert.equal(await call('evaluate', { tabId, expression: 'document.body.dataset.dropped' }), 'yes');
  if (process.env.BROWSER_TEST_DOWNLOAD === '1') {
    await call('click', { tabId, selector: '#download' });
    assert.equal((await call('wait_download', { filenameContains: 'yandex-mcp-fixture.txt' })).state, 'complete');
  }
  await call('type', { tabId, selector: '#message', text: 'Привет из MCP', clear: true });
  const found = await call('find', { tabId, name: 'Отправить', role: 'button' });
  assert.deepEqual(found.elements.map(el => el.selector), ['#send']);
  await call('click', { tabId, selector: found.elements[0].selector });
  assert.match(JSON.stringify(await call('diff', { tabId, snapshotId: base.snapshotId })), /Привет из MCP/);
  assert.deepEqual(await call('evaluate', { tabId, expression: '({ text: document.querySelector("#result").textContent, ...testState })' }), {
    text: 'Привет из MCP', clicks: 1, trusted: true, doubleClicks: 0,
  });
  await call('type', { tabId, selector: '#cell', text: '250', clear: true });
  assert.equal(await call('evaluate', { tabId, expression: 'document.querySelector("#cell").textContent' }), '250');
  await call('click', { tabId, selector: '#double', clickCount: 2 });
  assert.equal(await call('evaluate', { tabId, expression: 'testState.doubleClicks' }), 1);
  const ambiguous = await client.callTool({ name: 'browser_click', arguments: { tabId, selector: '.duplicate' } });
  assert.equal(ambiguous.isError, true);
  await call('click', { tabId, selector: '#message' });
  await call('press', { tabId, key: 'a', modifiers: ['Control'] });
  await call('type', { tabId, text: 'Замена' });
  assert.equal(await call('evaluate', { tabId, expression: 'document.querySelector("#message").value' }), 'Замена');
  const pos = await call('evaluate', { tabId, expression: '(()=>{const box=document.querySelector("#scrollbox");box.scrollIntoView({block:"center"});const r=box.getBoundingClientRect();return {x:r.x+20,y:r.y+20}})()' });
  await call('scroll', { tabId, deltaY: 200, ...pos });
  let scrollTop = 0;
  for (let i = 0; i < 20 && scrollTop === 0; i++) {
    await delay(100);
    scrollTop = await call('evaluate', { tabId, expression: 'document.querySelector("#scrollbox").scrollTop' });
  }
  assert.ok(scrollTop > 0, 'Nested scrolling failed');
  const screenshot = await call('screenshot', { tabId });
  assert.equal(screenshot.mimeType, 'image/png');
  assert.equal(Buffer.from(screenshot.data, 'base64').subarray(1, 4).toString(), 'PNG');
  const raw = await call('cdp', { tabId, method: 'Runtime.evaluate', params: { expression: '6*7', returnByValue: true } });
  assert.equal(raw.result.value, 42);
  await call('navigate', { tabId, url: `${url}?navigated=1` });
  let currentUrl;
  for (let i = 0; i < 20; i++) {
    await delay(100);
    currentUrl = (await call('snapshot', { tabId })).url;
    if (currentUrl.includes('navigated=1')) break;
  }
  assert.match(currentUrl, /navigated=1/);
  await call('history', { tabId, action: 'back' });
  assert.equal((await call('snapshot', { tabId })).url, url);
  console.log('PASS: browser fixture, element search, trusted click, Russian text, table editing, double click, keyboard, nested scrolling, screenshot, CDP, navigation and password omission.');
} finally {
  if (tabId !== undefined) await call('close', { tabId }).catch(console.error);
  if (originalTab !== undefined) await call('activate', { tabId: originalTab }).catch(console.error);
  await client.close();
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
}
