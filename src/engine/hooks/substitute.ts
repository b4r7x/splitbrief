import type { EngineEvent } from '../events/types.js';
import { boundConsumerPayload } from '../../core/payload-bounds.js';

const PLACEHOLDER_RE = /\$\{event\.([a-zA-Z_][\w.]*)\}/g;
const LEADING_PLACEHOLDER_RE = /^\$\{event\.[a-zA-Z_][\w.]*\}/;

export function startsWithEventPlaceholder(template: string): boolean {
  return LEADING_PLACEHOLDER_RE.test(template);
}

export function substituteEventFields(template: string, event: EngineEvent): string {
  return template.replace(PLACEHOLDER_RE, (_match, path: string) => {
    const value = readPath(event as unknown as Record<string, unknown>, path.split('.'));
    if (value === undefined || value === null) return '';
    const protectedValue = boundConsumerPayload({ context: 'hooks', payload: value }).payload;
    if (typeof protectedValue === 'string') return protectedValue;
    if (typeof protectedValue === 'number' || typeof protectedValue === 'boolean') {
      return String(protectedValue);
    }
    if (protectedValue === null) return '';
    return JSON.stringify(protectedValue);
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
