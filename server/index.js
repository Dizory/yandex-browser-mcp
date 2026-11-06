import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BrowserBridge } from './bridge.js';
import { createMcpServer } from './tools.js';

export const PORT = 37891;

function localRequest(req, port) {
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export async function startServer({ port = PORT, timeoutMs } = {}) {
  const bridge = new BrowserBridge({ timeoutMs });
  const transports = new Set();
  const server = createServer(async (req, res) => {
    if (!localRequest(req, server.address().port)) {
      res.writeHead(403).end('Local requests only');
      return;
    }
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'yandex-browser-mcp', version: '0.2.0', connected: bridge.connected === true }));
      return;
    }
    if (req.url !== '/mcp') { res.writeHead(404).end('Not found'); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end('Use MCP POST requests'); return; }
    if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415).end('Expected application/json'); return; }
    let mcp;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) { res.writeHead(413).end('Request too large'); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { res.writeHead(400).end('Invalid JSON'); return; }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      mcp = createMcpServer(bridge);
      transports.add(mcp);
      res.on('close', () => { transports.delete(mcp); void mcp.close().catch(() => {}); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
      else res.end();
      if (mcp) { transports.delete(mcp); await mcp.close().catch(() => {}); }
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const extensionOrigin = !origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    if (req.url !== '/extension' || !extensionOrigin || !localRequest({ headers: { host: req.headers.host } }, server.address().port) || bridge.connected) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => bridge.attach(client));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    server, bridge, port: server.address().port,
    async close() {
      for (const client of wss.clients) client.terminate();
      await Promise.all([...transports].map((mcp) => mcp.close().catch(() => {})));
      await new Promise((resolve) => wss.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const app = await startServer();
    console.error(`Yandex Browser MCP: http://127.0.0.1:${app.port}/mcp`);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
      process.exit(0);
    });
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Check http://127.0.0.1:${PORT}/health` : error.message);
    process.exitCode = 1;
  }
}
