import type { ZodIssue } from 'zod';
import { sanitizeTerminalDiagnosticText } from '../../utils/display-text.js';
import { UNKNOWN_UPSTREAM_RAW_PREVIEW_MAX_LENGTH } from './schema.js';

const MAX_PREVIEW_DEPTH = 4;
const MAX_COLLECTION_ITEMS = 20;
const MAX_KEY_CHARS = 128;
const TRUNCATED = '...';
const hasOwn = Object.prototype.hasOwnProperty;

export function runnerCallUnknownUpstreamPreview(opts: {
  label: string;
  value: unknown;
  issues?: readonly Pick<ZodIssue, 'path' | 'message'>[] | undefined;
}): string {
  const issueText =
    opts.issues === undefined || opts.issues.length === 0
      ? ''
      : `: ${formatZodIssues(opts.issues)}`;
  return sanitizeTerminalDiagnosticText(
    `${opts.label}${issueText}\n${previewUnknown(opts.value)}`,
    {
      maxChars: UNKNOWN_UPSTREAM_RAW_PREVIEW_MAX_LENGTH,
    },
  );
}

export function formatZodIssues(issues: readonly Pick<ZodIssue, 'path' | 'message'>[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'value';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function previewUnknown(value: unknown): string {
  return boundedPreview(value, UNKNOWN_UPSTREAM_RAW_PREVIEW_MAX_LENGTH, {
    depth: 0,
    seen: new WeakSet<object>(),
  });
}

function boundedPreview(
  value: unknown,
  maxChars: number,
  state: { depth: number; seen: WeakSet<object> },
): string {
  if (maxChars <= 0) return '';
  if (value === null) return fitPreview('null', maxChars);

  switch (typeof value) {
    case 'string':
      return quotedPreview(value, maxChars);
    case 'number':
    case 'boolean':
      return fitPreview(String(value), maxChars);
    case 'bigint':
      return fitPreview(`${value}n`, maxChars);
    case 'undefined':
      return fitPreview('undefined', maxChars);
    case 'symbol':
      return fitPreview(value.description ? `Symbol(${value.description})` : 'Symbol()', maxChars);
    case 'function':
      return fitPreview(`[Function ${value.name || 'anonymous'}]`, maxChars);
    case 'object':
      return objectPreview(value, maxChars, state);
    default:
      return fitPreview(String(value), maxChars);
  }
}

function objectPreview(
  value: object,
  maxChars: number,
  state: { depth: number; seen: WeakSet<object> },
): string {
  if (state.seen.has(value)) return fitPreview('"[Circular]"', maxChars);
  if (state.depth >= MAX_PREVIEW_DEPTH) return fitPreview('"[MaxDepth]"', maxChars);

  if (value instanceof Error) {
    return objectFromEntriesPreview(
      [
        ['name', value.name],
        ['message', value.message],
      ],
      maxChars,
      state,
    );
  }

  state.seen.add(value);
  try {
    if (Array.isArray(value)) return arrayPreview(value, maxChars, state);
    return objectPreviewEntries(value, maxChars, state);
  } finally {
    state.seen.delete(value);
  }
}

function arrayPreview(
  value: readonly unknown[],
  maxChars: number,
  state: { depth: number; seen: WeakSet<object> },
): string {
  let result = '[';
  let emitted = 0;
  for (const item of value) {
    if (emitted >= MAX_COLLECTION_ITEMS) {
      result = appendPreviewPart(result, TRUNCATED, maxChars);
      break;
    }
    const prefix = emitted === 0 ? '' : ',';
    const remaining = maxChars - result.length - prefix.length - 1;
    if (remaining <= 0) {
      result = appendPreviewPart(result, TRUNCATED, maxChars);
      break;
    }
    result += prefix;
    result = appendPreviewPart(
      result,
      boundedPreview(item, remaining, { depth: state.depth + 1, seen: state.seen }),
      maxChars,
    );
    emitted += 1;
  }
  return fitPreview(`${result}]`, maxChars);
}

function objectFromEntriesPreview(
  entries: readonly [string, unknown][],
  maxChars: number,
  state: { depth: number; seen: WeakSet<object> },
): string {
  let result = '{';
  let emitted = 0;
  for (const [key, item] of entries) {
    if (emitted >= MAX_COLLECTION_ITEMS) {
      result = appendPreviewPart(result, TRUNCATED, maxChars);
      break;
    }
    const safeKey = JSON.stringify(key.slice(0, MAX_KEY_CHARS));
    const prefix = emitted === 0 ? '' : ',';
    const keyPrefix = `${prefix}${safeKey}:`;
    const remaining = maxChars - result.length - keyPrefix.length - 1;
    if (remaining <= 0) {
      result = appendPreviewPart(result, TRUNCATED, maxChars);
      break;
    }
    result += keyPrefix;
    result = appendPreviewPart(
      result,
      boundedPreview(item, remaining, { depth: state.depth + 1, seen: state.seen }),
      maxChars,
    );
    emitted += 1;
  }
  return fitPreview(`${result}}`, maxChars);
}

function objectPreviewEntries(
  value: object,
  maxChars: number,
  state: { depth: number; seen: WeakSet<object> },
): string {
  let result = '{';
  let emitted = 0;
  for (const key in value) {
    if (!hasOwn.call(value, key)) continue;
    if (emitted >= MAX_COLLECTION_ITEMS) {
      result = appendPreviewPart(result, TRUNCATED, maxChars);
      break;
    }
    const safeKey = JSON.stringify(key.slice(0, MAX_KEY_CHARS));
    const prefix = emitted === 0 ? '' : ',';
    const keyPrefix = `${prefix}${safeKey}:`;
    const remaining = maxChars - result.length - keyPrefix.length - 1;
    if (remaining <= 0) {
      result = appendPreviewPart(result, TRUNCATED, maxChars);
      break;
    }
    result += keyPrefix;
    result = appendPreviewPart(
      result,
      boundedPreview(readOwnProperty(value, key), remaining, {
        depth: state.depth + 1,
        seen: state.seen,
      }),
      maxChars,
    );
    emitted += 1;
  }
  return fitPreview(`${result}}`, maxChars);
}

function readOwnProperty(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function quotedPreview(value: string, maxChars: number): string {
  if (maxChars <= 2) return fitPreview(JSON.stringify(value.slice(0, maxChars)), maxChars);
  const innerBudget = Math.max(0, maxChars - 2 - TRUNCATED.length);
  const sliced =
    value.length + 2 <= maxChars ? value : `${value.slice(0, innerBudget)}${TRUNCATED}`;
  return fitPreview(JSON.stringify(sliced), maxChars);
}

function appendPreviewPart(current: string, part: string, maxChars: number): string {
  return fitPreview(`${current}${part}`, maxChars);
}

function fitPreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATED.length) return TRUNCATED.slice(0, maxChars);
  return `${text.slice(0, maxChars - TRUNCATED.length)}${TRUNCATED}`;
}
