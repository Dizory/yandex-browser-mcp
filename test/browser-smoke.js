import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const html = await readFile(new URL('./fixture.html', import.meta.url));
const fixture = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); });
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
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:37891/mcp')));
  const tabs = await call('tabs');
  originalTab = tabs.find((tab) => tab.active)?.id;
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  tabId = (await call('open', { url })).id;
  assert.ok(Number.isInteger(tabId));
  await call('activate', { tabId });
  let snapshot;
  for (let attempt = 0; attempt < 20; attempt++) {
    snapshot = await call('snapshot', { tabId });
    if (snapshot.text.includes('Проверка управления')) break;
    await delay(250);
  }
  assert.match(snapshot.text, /Проверка управления/);
  assert.ok(!JSON.stringify(snapshot).includes('fixture-secret-not-real'), 'Snapshot leaked password input value');
  assert.ok(snapshot.elements.some((element) => element.selector === '#message'));
  await call('type', { tabId, selector: '#message', text: 'Привет из MCP', clear: true });
  await call('click', { tabId, selector: '#send' });
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
  const pos = await call('evaluate', { tabId, expression: '(()=>{const r=document.querySelector("#scrollbox").getBoundingClientRect();return {x:r.x+20,y:r.y+20}})()' });
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
  console.log('PASS: all 13 tools in a real browser; trusted click, Russian text, table editing, double click, keyboard, nested scrolling, screenshot, CDP, navigation and password omission.');
} finally {
  if (tabId !== undefined) await call('close', { tabId }).catch(console.error);
  if (originalTab !== undefined) await call('activate', { tabId: originalTab }).catch(console.error);
  await client.close();
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
}
