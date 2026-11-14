import { isRecord } from '../../utils/type-guards.js';

export type JsonExtraction =
  | Readonly<{ kind: 'ok'; value: unknown }>
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'ambiguous' }>
  | Readonly<{ kind: 'truncated' }>;

const FENCE = /```[\w-]*[ \t]*\n([\s\S]*?)\n```/g;
const JSON_OPENING = /^\s*\{\s*("|\})/;

/** The end of the object that opens at `start`, string-aware; undefined when it never closes. */
function objectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
}

const CUT = -1;
const BAD = -2;
const FIRST_KEY = /^\{\s*"(?:[^"\\]|\\.)*"\s*:/;
const LITERAL = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;
const NUMBER_PREFIX = /^-?$|^-?(?:0|[1-9]\d*)(?:\.|\.\d+(?:[eE][+-]?\d*)?|[eE][+-]?\d*)?$/;

function isLiteralPrefix(token: string): boolean {
  return (
    ['true', 'false', 'null'].some((word) => word.startsWith(token)) || NUMBER_PREFIX.test(token)
  );
}

function skipSpace(text: string, i: number): number {
  let at = i;
  while (at < text.length && ' \t\n\r'.includes(text.charAt(at))) at++;
  return at;
}

/** The end of the JSON value at `i`; CUT when the text ends inside it, BAD when it is not JSON. */
function scanValue(text: string, i: number): number {
  const at = skipSpace(text, i);
  if (at >= text.length) return CUT;
  const ch = text[at];
  if (ch === '{') return scanContainer(text, at, '}');
  if (ch === '[') return scanContainer(text, at, ']');
  if (ch === '"') return scanString(text, at);
  let end = at;
  while (end < text.length && /[\w.+-]/.test(text.charAt(end))) end++;
  if (end >= text.length) return isLiteralPrefix(text.slice(at)) ? CUT : BAD;
  return LITERAL.test(text.slice(at, end)) ? end : BAD;
}

function scanString(text: string, i: number): number {
  for (let at = i + 1; at < text.length; at++) {
    if (text[at] === '\\') at++;
    else if (text[at] === '"') return at + 1;
  }
  return CUT;
}

function scanContainer(text: string, i: number, close: '}' | ']'): number {
  let at = skipSpace(text, i + 1);
  if (at >= text.length) return CUT;
  if (text[at] === close) return at + 1;
  for (;;) {
    if (close === '}') {
      if (text[at] !== '"') return BAD;
      at = scanString(text, at);
      if (at < 0) return at;
      at = skipSpace(text, at);
      if (at >= text.length) return CUT;
      if (text[at] !== ':') return BAD;
      at++;
    }
    at = scanValue(text, at);
    if (at < 0) return at;
    at = skipSpace(text, at);
    if (at >= text.length) return CUT;
    if (text[at] === close) return at + 1;
    if (text[at] !== ',') return BAD;
    at = skipSpace(text, at + 1);
    if (at >= text.length) return CUT;
  }
}

/**
 * An unclosed object is a truncated answer when it gets past its first key and everything up to
 * the end of the text is the start of valid JSON; `{"b" from the old shape` is prose.
 */
function isTruncatedObject(tail: string): boolean {
  return FIRST_KEY.test(tail) && scanValue(tail, 0) === CUT;
}

type Candidate = Readonly<{ start: number; end: number; body: string; bare: boolean }>;

function parseObject(body: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The answer is the object that parses and ends last, fenced or bare. A fence counts when
 * its body opens an object, and its contents never yield a bare object. A later brace span
 * that does not parse is skipped when it reads as prose (`{above}`); one that opens like
 * JSON is the malformed answer, never hidden by an earlier object. An object outside every
 * closed span that never closes and is a valid JSON prefix to the end: the answer is truncated.
 */
export function extractLastJsonObject(text: string): JsonExtraction {
  let unfenced = text;
  const candidates: Candidate[] = [];
  for (const match of text.matchAll(FENCE)) {
    const end = match.index + match[0].length;
    unfenced = unfenced.slice(0, match.index) + ' '.repeat(match[0].length) + unfenced.slice(end);
    const body = match[1] ?? '';
    if (body.trimStart().startsWith('{')) {
      candidates.push({ start: match.index, end, body, bare: false });
    }
  }
  let closedUntil = 0;
  for (let i = unfenced.indexOf('{'); i !== -1; i = unfenced.indexOf('{', i + 1)) {
    const end = objectEnd(unfenced, i);
    if (end !== undefined) {
      candidates.push({ start: i, end, body: text.slice(i, end), bare: true });
      closedUntil = Math.max(closedUntil, end);
    } else if (i >= closedUntil && isTruncatedObject(unfenced.slice(i))) {
      return { kind: 'truncated' };
    }
  }
  if (candidates.length === 0) return { kind: 'none' };

  candidates.sort((a, b) => b.end - a.end || a.start - b.start);
  for (const [index, last] of candidates.entries()) {
    const value = parseObject(last.body);
    if (value === undefined) {
      if (JSON_OPENING.test(last.body)) return { kind: 'invalid' };
      continue;
    }
    const adjacent =
      last.bare &&
      candidates
        .slice(index + 1)
        .some(
          (other) =>
            other.bare &&
            other.end <= last.start &&
            text.slice(other.end, last.start).trim() === '' &&
            parseObject(other.body) !== undefined,
        );
    return adjacent ? { kind: 'ambiguous' } : { kind: 'ok', value };
  }
  return { kind: 'invalid' };
}
