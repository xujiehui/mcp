import { createHash } from 'node:crypto';
import { MoonvyError } from './errors.js';

export function scopeHash(scope: unknown) {
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex').slice(0, 24);
}
export function makeCursor(revision: string, scope: unknown, offset: number) {
  return Buffer.from(JSON.stringify({ revision, scope: scopeHash(scope), offset })).toString('base64url');
}
export function readCursor(cursor: string | undefined, revision: string, scope: unknown): number {
  if (!cursor) return 0;
  let value: any;
  try {
    if (cursor.length > 512 || !/^[\w-]+$/.test(cursor)) throw new Error();
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.scope !== scopeHash(scope)) throw new Error();
  } catch { throw new MoonvyError('INVALID_CURSOR', 'Cursor does not match this query.'); }
  if (value.revision !== revision) throw new MoonvyError('STALE_CURSOR', 'Design changed; restart pagination without cursor.');
  return value.offset;
}
