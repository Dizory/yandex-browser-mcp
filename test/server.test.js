import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../server/index.js';

async function setup(t, options = {}) {
  const app = await startServer({ port: 0, ...options });
  t.after(() => app.close());
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`)));
  t.after(() => client.close());
  return { app, client, base: `http://127.0.0.1:${app.port}` };
}

async function browser(t, app, handle) {
  const socket = new WebSocket(`ws://127.0.0.1:${app.port}/extension`, { origin: `chrome-extension://${'a'.repeat(32)}` });
  socket.on('message', (data) => handle(JSON.parse(data), socket));
  await once(socket, 'open');
  t.after(() => socket.terminate());
  return socket;
}

test('real MCP handshake, discover tools and disconnected error', async (t) => {
  const { client, base } = await setup(t);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 13);
  assert.equal(tools.find((tool) => tool.name === 'browser_click').inputSchema.type, 'object');
  const result = await client.callTool({ name: 'browser_tabs', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not connected/);
  assert.equal((await (await fetch(`${base}/health`)).json()).connected, false);
});

test('routes concurrent requests by id across independent MCP clients', async (t) => {
  const { app, client, base } = await setup(t);
  const second = new Client({ name: 'second', version: '1' });
  await second.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  t.after(() => second.close());
  const requests = [];
  await browser(t, app, (message, socket) => {
    requests.push(message);
    if (requests.length === 2) for (const request of requests.toReversed()) socket.send(JSON.stringify({ id: request.id, result: request.params.tabId }));
  });
  const [a, b] = await Promise.all([
    client.callTool({ name: 'browser_snapshot', arguments: { tabId: 10 } }),
    second.callTool({ name: 'browser_snapshot', arguments: { tabId: 20 } }),
  ]);
  assert.equal(a.content[0].text, '10');
  assert.equal(b.content[0].text, '20');
  assert.equal(app.bridge.pending.size, 0);
});

test('validates input before sending commands and returns browser errors', async (t) => {
  const { app, client } = await setup(t);
  const requests = [];
  await browser(t, app, (message, socket) => {
    requests.push(message);
    socket.send(JSON.stringify({ id: message.id, error: 'Element is ambiguous' }));
  });
  for (const args of [{ tabId: 1 }, { tabId: 1, x: 2 }, { tabId: 1, selector: '#a', x: 1, y: 2 }]) {
    assert.equal((await client.callTool({ name: 'browser_click', arguments: args })).isError, true);
  }
  assert.equal((await client.callTool({ name: 'browser_open', arguments: { url: 'javascript:alert(1)' } })).isError, true);
  assert.equal((await client.callTool({ name: 'browser_type', arguments: { tabId: -1, text: 'a' } })).isError, true);
  assert.equal(requests.length, 0);
  const result = await client.callTool({ name: 'browser_click', arguments: { tabId: 1, selector: 'button' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ambiguous/);
  assert.equal(requests.length, 1);
});

test('screenshot uses MCP image content', async (t) => {
  const { app, client } = await setup(t);
  await browser(t, app, (message, socket) => socket.send(JSON.stringify({ id: message.id, result: { data: 'aGVsbG8=', mimeType: 'image/png' } })));
  const result = await client.callTool({ name: 'browser_screenshot', arguments: { tabId: 1 } });
  assert.deepEqual(result.content, [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]);
});

test('timeout does not resend a mutation; late reply is ignored', async (t) => {
  const { app, client } = await setup(t, { timeoutMs: 50 });
  const requests = [];
  const socket = await browser(t, app, (message) => requests.push(message));
  const result = await client.callTool({ name: 'browser_click', arguments: { tabId: 1, x: 2, y: 3 } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /may already have run/);
  assert.equal(requests.length, 1);
  assert.equal(app.bridge.pending.size, 0);
  socket.send(JSON.stringify({ id: requests[0].id, result: { clicked: true } }));
});

test('disconnect rejects pending actions and allows reconnect', async (t) => {
  const { app, client } = await setup(t);
  const socket = await browser(t, app, (_message, ws) => ws.close());
  const result = await client.callTool({ name: 'browser_type', arguments: { tabId: 1, text: 'hello' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /disconnected/);
  assert.equal(socket.readyState, WebSocket.CLOSED);
  await browser(t, app, (message, ws) => ws.send(JSON.stringify({ id: message.id, result: [] })));
  assert.equal((await client.callTool({ name: 'browser_tabs', arguments: {} })).isError, undefined);
});

test('rejects external web origins and malformed JSON', async (t) => {
  const { base, app } = await setup(t);
  assert.equal((await fetch(`${base}/health`, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
  const bad = new WebSocket(`ws://127.0.0.1:${app.port}/extension`, { origin: 'https://example.com' });
  const [error] = await once(bad, 'error');
  assert.match(error.message, /403/);
});
