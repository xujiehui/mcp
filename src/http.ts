import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type Services } from './server.js';

export function createHttpApp(services: Services) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const address = req.socket.localAddress;
    const port = req.socket.localPort;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(req.headers.host ?? '') || (address && !['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(address))) {
      res.status(403).json({ error: 'Invalid Host.' }); return;
    }
    if (req.headers.origin && !new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(req.headers.origin)) {
      res.status(403).json({ error: 'Invalid Origin.' }); return;
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.post('/mcp', async (req, res) => {
    const server = createServer(services, 'http');
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: 'MCP request failed.' }); }
  });
  app.all('/mcp', (_req, res) => { res.set('Allow', 'POST').status(405).json({ error: 'Use POST for stateless Streamable HTTP.' }); });
  app.use((_req, res) => { res.status(404).json({ error: 'Not found.' }); });
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid request body.' });
  });
  return app;
}
