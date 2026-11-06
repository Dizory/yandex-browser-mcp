import test from 'node:test';
import assert from 'node:assert/strict';
import { createSheetsApi, sheetsTools } from '../server/sheets.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../server/tools.js';

const spreadsheet = 'https://docs.google.com/spreadsheets/d/ABC_42/edit#gid=123';
const range = "'Отчёт 1'!A2:C3";
function parse(method, args) {
  return sheetsTools.find(tool => tool.method === method).schema.parse(args);
}

test('MCP dispatches Sheets independently of the browser and advertises optional input mode', async t => {
  const [left, right] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ request() { throw Error('Unexpected browser request'); } },
    async (method, args) => ({ method, range: args.updates[0].range, input: args.input }));
  const client = new Client({ name: 'sheets-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(right);
  await client.connect(left);
  const { tools } = await client.listTools();
  const write = tools.find(tool => tool.name === 'sheets_write');
  assert.ok(!write.inputSchema.required.includes('input'));
  const result = await client.callTool({ name: write.name, arguments: {
    spreadsheet, updates: [{ range, values: [[0, false, '']] }],
  } });
  assert.deepEqual(JSON.parse(result.content[0].text), { method: 'write', range, input: 'RAW' });
});

test('Sheets URL, document bounds and literal input are validated before HTTP', () => {
  assert.throws(() => parse('info', { spreadsheet: 'https://docs.google.com.evil.test/spreadsheets/d/123' }));
  for (const r of ['A1', 'Sheet!C9:A2', 'Sheet!A1:C99999', 'Sheet!A:A']) {
    assert.throws(() => parse('read', { spreadsheet, ranges: [r] }), r);
  }
  assert.throws(() => parse('write', { spreadsheet, updates: [{ range: 'Sheet!A1', values: [[1, 2]] }] }));
  const args = parse('write', { spreadsheet, updates: [{ range, values: [[0, false, null], ['=SUM(B1:B3)', '']] }] });
  assert.equal(args.input, 'RAW');
  assert.deepEqual(args.updates[0].values[0], [0, false, null]);
});

test('all Sheets tools target the official REST API and need no tab', async () => {
  const calls = [];
  const api = createSheetsApi({ token: async () => 'test-token', fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    return Response.json({ result: 'ok' });
  } });
  const fixtures = {
    info: { spreadsheet }, read: { spreadsheet, ranges: [range, "'Joe''s'!D4"], render: 'FORMULA' },
    write: { spreadsheet, updates: [{ range, values: [[1, false, '=B1']] }], input: 'USER_ENTERED' },
    append: { spreadsheet, range, values: [[1, '']] }, clear: { spreadsheet, ranges: [range] },
    add_sheet: { spreadsheet, title: 'Май' }, create: { title: 'Тест' },
  };
  for (const [method, args] of Object.entries(fixtures)) {
    assert.deepEqual(await api(method, parse(method, args)), { result: 'ok' });
  }
  for (const { url, init } of calls) {
    assert.equal(url.origin, 'https://sheets.googleapis.com');
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    assert.equal(init.redirect, 'error');
  }
  assert.equal(calls[0].url.pathname, '/v4/spreadsheets/ABC_42');
  assert.deepEqual(calls[1].url.searchParams.getAll('ranges'), fixtures.read.ranges);
  assert.equal(calls[1].url.searchParams.get('valueRenderOption'), 'FORMULA');
  assert.deepEqual(JSON.parse(calls[2].init.body), { valueInputOption: 'USER_ENTERED', data: fixtures.write.updates });
  assert.match(decodeURIComponent(calls[3].url.pathname), /Отчёт 1'!A2:C3:append$/);
  assert.equal(calls[3].url.searchParams.get('valueInputOption'), 'RAW');
  assert.deepEqual(JSON.parse(calls[4].init.body), { ranges: [range] });
  assert.equal(JSON.parse(calls[5].init.body).requests[0].addSheet.properties.title, 'Май');
  assert.equal(calls[6].url.pathname, '/v4/spreadsheets');
});

test('a failed append is never replayed and API errors preserve the reason', async () => {
  let attempts = 0;
  const api = createSheetsApi({ token: async () => 'secret', fetchImpl: async () => {
    attempts++; throw new Error('network reset');
  } });
  await assert.rejects(api('append', parse('append', { spreadsheet, range, values: [[1]] })), /inspect before retrying/);
  assert.equal(attempts, 1);
  const forbidden = createSheetsApi({ token: async () => 'secret', fetchImpl: async () =>
    Response.json({ error: { message: 'Permission denied' } }, { status: 403 }) });
  await assert.rejects(forbidden('info', { spreadsheet }), /403: Permission denied/);
});
