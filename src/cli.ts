#!/usr/bin/env node
import { config as dotenv } from 'dotenv';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createServer, createServices } from './server.js';
import { createHttpApp } from './http.js';
import { SERVER_VERSION } from './version.js';

dotenv({ quiet: true });

async function main() {
  const { values } = parseArgs({ options: { transport: { type: 'string', default: 'stdio' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } } });
  if (values.version) { console.log(SERVER_VERSION); return; }
  if (values.help) { console.log('moonvy-mcp [--transport stdio|http]\nHTTP: http://127.0.0.1:3333/mcp (MOONVY_PORT overrides port)'); return; }
  if (!['stdio', 'http'].includes(values.transport!)) throw new Error('transport must be stdio or http.');
  const config = loadConfig();
  const services = createServices(config);
  if (values.transport === 'stdio') {
    const server = createServer(services);
    await server.connect(new StdioServerTransport());
    const stop = () => { void server.close().finally(() => process.exit(0)); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } else {
    const listener = createHttpApp(services).listen(config.port, '127.0.0.1', () => console.error(`Moonvy MCP: http://127.0.0.1:${config.port}/mcp`));
    listener.on('error', () => { console.error('Unable to start Moonvy MCP HTTP listener. Check MOONVY_PORT.'); process.exitCode = 1; });
    const stop = () => { listener.close(() => process.exit(0)); listener.closeAllConnections(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }
}

main().catch(() => { console.error('Moonvy MCP startup failed. Check CLI options and local environment configuration.'); process.exitCode = 1; });
