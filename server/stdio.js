import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const client = new Client({ name: 'yandex-browser-mcp-proxy', version: '0.2.0' });
const server = new Server({ name: 'yandex-browser-mcp', version: '0.2.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => client.listTools());
server.setRequestHandler(CallToolRequestSchema, ({ params }) => client.callTool(params));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close().catch(() => {});
  await client.close().catch(() => {});
}
server.onclose = close;
process.on('SIGINT', close);
process.on('SIGTERM', close);
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:37891/mcp')));
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(`Start the browser bridge with npm start first. ${error.message}`);
  await close();
  process.exitCode = 1;
}
