import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, createServices } from '../src/server.js';
import { fixtureConfig, fixtureFetcher } from './fixtures.js';
import { readFile } from 'node:fs/promises';
const fetcher = fixtureFetcher(process.env.MOCK_GENOME_FILE ? async () => JSON.parse(await readFile(process.env.MOCK_GENOME_FILE!, 'utf8')) : undefined);
const server = createServer(createServices(fixtureConfig(process.env.MOCK_ASSET_DIR!), fetcher));
await server.connect(new StdioServerTransport());
