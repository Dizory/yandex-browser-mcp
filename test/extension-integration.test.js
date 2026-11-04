import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../server/index.js';

test('extension entry point connects and dispatches real MCP requests over WebSocket', { timeout: 10000 }, async (t) => {
  const app = await startServer({ port: 0 });
  t.after(() => app.close());
  const worker = new Worker(new URL('./extension-worker.js', import.meta.url), { workerData: { port: app.port } });
  t.after(() => worker.terminate());
  await once(worker, 'message');
  for (let i = 0; i < 100 && !app.bridge.connected; i++) await delay(20);
  assert.equal(app.bridge.connected, true);
  const client = new Client({ name: 'extension-integration', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`)));
  const tabs = await client.callTool({ name: 'browser_tabs', arguments: {} });
  assert.notEqual(tabs.isError, true);
  assert.equal(JSON.parse(tabs.content[0].text)[0].title, 'Fixture');
  const result = await client.callTool({ name: 'browser_evaluate', arguments: { tabId: 7, expression: '6*7' } });
  assert.equal(result.content[0].text, '42');
});
