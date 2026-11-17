import { resolve } from 'node:path';

export interface Config {
  token: string;
  apiBase: string;
  assetDir: string;
  port: number;
  timeoutMs: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  cacheMaxBytes: number;
  maxGenomeBytes: number;
  maxAssetBytes: number;
  maxImageBytes: number;
  maxRetries: number;
  retryBaseMs: number;
  assetTtlMs: number;
  assetMaxBytes: number;
  componentMapPath: string;
  resourceMode: 'text' | 'blob';
  snapshotDir: string;
  snapshotTtlMs: number;
  snapshotMaxBytes: number;
  snapshotMaxEntries: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const positive = (key: string, fallback: number) => {
    if (!env[key]) return fallback;
    const value = Number(env[key]);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer.`);
    return value;
  };
  const port = positive('MOONVY_PORT', 3333);
  if (port > 65535) throw new Error('MOONVY_PORT must be <= 65535.');
  const maxRetries = env.MOONVY_MAX_RETRIES === undefined ? 2 : Number(env.MOONVY_MAX_RETRIES);
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new Error('MOONVY_MAX_RETRIES must be between 0 and 5.');
  const resourceMode = env.MOONVY_RESOURCE_MODE || 'text';
  if (resourceMode !== 'text' && resourceMode !== 'blob') throw new Error('MOONVY_RESOURCE_MODE must be text or blob.');
  return {
    token: String(env.MOONVY_TOKEN ?? '').trim().replace(/^Bearer\s+/i, '').trim(),
    apiBase: 'https://global-api.moonvy.com/v2',
    assetDir: resolve(env.MOONVY_ASSET_DIR || '.moonvy/assets'),
    port,
    timeoutMs: positive('MOONVY_TIMEOUT_MS', 30_000),
    cacheTtlMs: positive('MOONVY_CACHE_TTL_MS', 300_000),
    cacheMaxEntries: positive('MOONVY_CACHE_MAX_ENTRIES', 20),
    cacheMaxBytes: positive('MOONVY_CACHE_MAX_BYTES', 128 * 1024 * 1024),
    maxGenomeBytes: positive('MOONVY_MAX_GENOME_BYTES', 50 * 1024 * 1024),
    maxAssetBytes: positive('MOONVY_MAX_ASSET_BYTES', 20 * 1024 * 1024),
    maxImageBytes: positive('MOONVY_MAX_IMAGE_BYTES', 5 * 1024 * 1024),
    maxRetries,
    retryBaseMs: positive('MOONVY_RETRY_BASE_MS', 200),
    assetTtlMs: positive('MOONVY_ASSET_TTL_MS', 7 * 24 * 60 * 60 * 1000),
    assetMaxBytes: positive('MOONVY_ASSET_MAX_BYTES', 512 * 1024 * 1024),
    componentMapPath: resolve(env.MOONVY_COMPONENT_MAP || '.moonvy/components.json'),
    resourceMode,
    snapshotDir: resolve(env.MOONVY_SNAPSHOT_DIR || '.moonvy/snapshots'),
    snapshotTtlMs: positive('MOONVY_SNAPSHOT_TTL_MS', 30 * 24 * 60 * 60 * 1000),
    snapshotMaxBytes: positive('MOONVY_SNAPSHOT_MAX_BYTES', 128 * 1024 * 1024),
    snapshotMaxEntries: positive('MOONVY_SNAPSHOT_MAX_ENTRIES', 20),
  };
}
