import type { EngineEvent } from '../events/types.js';

const PLACEHOLDER_RE = /\$\{event\.([a-zA-Z_][\w.]*)\}/g;
const LEADING_PLACEHOLDER_RE = /^\$\{event\.[a-zA-Z_][\w.]*\}/;

export function startsWithEventPlaceholder(template: string): boolean {
  return LEADING_PLACEHOLDER_RE.test(template);
}

export function substituteEventFields(template: string, event: EngineEvent): string {
  return template.replace(PLACEHOLDER_RE, (_match, path: string) => {
    const value = readPath(event as unknown as Record<string, unknown>, path.split('.'));
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  });
}

function readPath(obj: Record<string, unknown>, keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
