export class MoonvyError extends Error {
  stage?: string;
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'MoonvyError';
  }
}

export function redact(value: unknown, secrets: string[] = []): unknown {
  const sensitive = /(^|[_-])(authorization|cookies?|credentials?|jwt|password|secret|session|(?:access[_-]?|refresh[_-]?)?token)([_-]|$)/i;
  function visit(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, val]) => [key, sensitive.test(key) ? '[REDACTED]' : visit(val)]));
    }
    if (typeof input !== 'string') return input;
    let text = input;
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
    return text
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
      .replace(/https?:\/\/[^\s<>"']+/g, (raw) => {
        try {
          const url = new URL(raw);
          url.username = ''; url.password = ''; url.search = ''; url.hash = '';
          return url.toString();
        } catch { return '[REDACTED_URL]'; }
      });
  }
  return visit(value);
}
