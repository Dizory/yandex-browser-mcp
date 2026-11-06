import { z } from 'zod';
import { sheetsAccessToken } from './sheets-auth.js';

const spreadsheetId = /^[a-zA-Z0-9_-]{1,200}$/;
const docsUrl = /^https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{1,200})(?:[/?#]|$)/;
function resolveId(value) {
  return spreadsheetId.test(value) ? value : docsUrl.exec(value)?.[1];
}
const book = { spreadsheet: z.string().max(4096).refine(value => !!resolveId(value), 'Use a Google Sheets URL or spreadsheet ID') };
const qualified = /^(?:'(?:[^']|'')+'|[^'!]+)!\$?([A-Z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Z]{1,3})\$?([1-9]\d{0,6}))?$/i;
function rangeSize(range) {
  const match = qualified.exec(range);
  if (!match) return null;
  const column = letters => [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const width = column(match[3] || match[1]) - column(match[1]) + 1;
  const height = Number(match[4] || match[2]) - Number(match[2]) + 1;
  return width > 0 && height > 0 ? { width, height, cells: width * height } : null;
}
const range = z.string().max(500).refine(r => !!rangeSize(r), 'Use a sheet-qualified A1 cell or rectangle, e.g. Orders!A2:C9');
const ranges = z.array(range).min(1).max(50).refine(items =>
  items.reduce((sum, r) => sum + (rangeSize(r)?.cells ?? Infinity), 0) <= 10000, 'Request up to 10000 cells at once');
const cell = z.union([z.string().max(50000), z.number().finite(), z.boolean(), z.null()]);
const values = z.array(z.array(cell).min(1).max(10000)).min(1).max(10000)
  .refine(rows => rows.reduce((sum, row) => sum + row.length, 0) <= 10000, 'Maximum 10000 input values');
const update = z.strictObject({ range, values }).refine(({ range: address, values: rows }) => {
  const size = rangeSize(address);
  return !!size && rows.length <= size.height && rows.every(row => row.length <= size.width);
}, 'Values must fit inside the specified A1 rectangle');
const mode = { input: z.enum(['RAW', 'USER_ENTERED']).default('RAW').describe('Use USER_ENTERED explicitly to interpret formulas and localized dates') };
const title = z.string().trim().min(1).max(100);
const metadata = 'spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))';
const definitions = [
  ['info', 'Get spreadsheet title and sheet names, IDs and sizes. Accepts a document link or ID.', book],
  ['read', 'Read one or more sheet-qualified A1 ranges in order. Choose FORMULA to return formulas, UNFORMATTED_VALUE for numbers.', { ...book, ranges, render: z.enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA']).default('FORMATTED_VALUE') }],
  ['write', 'Write one or more explicit rectangles in one batch. Null skips a cell; empty string empties it. Defaults to literal RAW input.', { ...book, updates: z.array(update).min(1).max(50), ...mode }],
  ['append', 'Append rows after the logical table found in the specified A1 range. The response gives the actual written range. Inspect before retrying.', { ...book, range, values, ...mode }],
  ['clear', 'Clear values in explicit A1 ranges, preserving formatting.', { ...book, ranges }],
  ['add_sheet', 'Add a named worksheet to an existing spreadsheet.', { ...book, title }],
  ['create', 'Create a spreadsheet in the authorized Google account and return its URL and sheet metadata.', { title }],
];
export const sheetsTools = definitions.map(([method, description, shape]) => ({
  method, name: 'sheets_' + method, description, schema: z.strictObject(shape),
}));

export function createSheetsApi({ token = sheetsAccessToken, fetchImpl = fetch } = {}) {
  return async (method, p) => {
    const root = 'https://sheets.googleapis.com/v4/spreadsheets';
    const path = p.spreadsheet ? '/' + resolveId(p.spreadsheet) : '';
    let suffix = '';
    let body;
    const query = new URLSearchParams();
    switch (method) {
      case 'info': query.set('fields', metadata); break;
      case 'create': query.set('fields', metadata); body = { properties: { title: p.title } }; break;
      case 'add_sheet':
        suffix = ':batchUpdate';
        body = { requests: [{ addSheet: { properties: { title: p.title } } }] }; break;
      case 'read':
        suffix = '/values:batchGet';
        for (const range of p.ranges) query.append('ranges', range);
        query.set('valueRenderOption', p.render); break;
      case 'write':
        suffix = '/values:batchUpdate'; body = { valueInputOption: p.input, data: p.updates }; break;
      case 'clear':
        suffix = '/values:batchClear'; body = { ranges: p.ranges }; break;
      case 'append':
        suffix = '/values/' + encodeURIComponent(p.range) + ':append';
        query.set('insertDataOption', 'INSERT_ROWS'); query.set('valueInputOption', p.input);
        body = { values: p.values }; break;
      default: throw new Error('Unknown Sheets command');
    }
    const accessToken = await token();
    let response;
    try {
      response = await fetchImpl(root + path + suffix + (query.size ? '?' + query : ''), {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: body && JSON.stringify(body),
      });
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) throw new Error('Response too large');
        chunks.push(chunk);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (response.ok) return result;
      throw new Error('Google Sheets HTTP ' + response.status + ': ' + (result.error?.message || 'Request failed').slice(0, 1000));
    } catch (error) {
      if (error.message.startsWith('Google Sheets HTTP')) throw error;
      throw new Error((error.message === 'Response too large' ? 'Response too large. Use smaller ranges.' : 'Google Sheets request failed or timed out.') +
        (body ? ' The change may have run; inspect before retrying.' : ''));
    }
  };
}
