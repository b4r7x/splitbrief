import { isInDeclaredSet } from '../../core/scope/declared-set.js';
import type { RunnerCallStatus } from '../calls/types.js';
import { FileBundleSchema, type BundleBaseline, type FileBundleEntry } from './file-bundle.js';

export const FILE_BUNDLE_MAX_FILE_BYTES = 1024 * 1024;
export const FILE_BUNDLE_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface FileBundleCandidate {
  path: string;
  action: 'create' | 'modify';
  content: string;
}

export interface ParseFileBundleInput {
  /** The whole BUILD response text, exactly as the transport recorded it. */
  text: string;
  /** Only `completed` may reach the parser; every other terminal status is a failure. */
  status: RunnerCallStatus;
  /** Baselines captured from the confined filesystem, one per declared target. */
  targets: readonly BundleBaseline[];
  /** The brief's declared patterns; a captured target must still sit inside them. */
  scope: readonly string[];
}

export type ParseFileBundleResult =
  | {
      kind: 'parsed';
      candidates: FileBundleCandidate[];
      noops: string[];
      untouched: string[];
    }
  | {
      kind: 'blocked';
      question: string;
      filesNeeded: string[];
    }
  | {
      kind: 'rejected';
      code: 'invalid-bundle' | 'unsafe-target' | 'output-limit' | 'no-changes';
      error: string;
    };

function byPath(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function rejected(
  code: 'invalid-bundle' | 'unsafe-target' | 'output-limit' | 'no-changes',
  error: string,
): ParseFileBundleResult {
  return { kind: 'rejected', code, error };
}

/**
 * The response body: one raw JSON object, or one whole ```json fence. Anything
 * else — prose around it, a second object, the longest of several fences — is a
 * malformed response, never something to repair or fall back from.
 */
function unwrapBundleText(text: string): { json: string } | { error: string } {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    const fence = /^```json\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
    if (fence?.[1] === undefined) {
      return { error: 'response is not one entire ```json fence' };
    }
    return { json: fence[1] };
  }
  if (!trimmed.startsWith('{')) return { error: 'response is not a bare JSON bundle object' };
  return { json: trimmed };
}

/**
 * Path spellings a target may never take. Shared with baseline capture so a
 * declared target and a response entry are judged by exactly one rule set.
 */
export function unsafePathReason(path: string): string | undefined {
  if (path.length === 0) return 'empty path';
  if (path.includes('\0')) return 'NUL byte in path';
  if (path.includes('\\')) return 'backslash in path';
  if (path.startsWith('/')) return 'absolute path';
  if (/^[a-zA-Z]:/.test(path)) return 'drive-letter path';
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'))
    return 'empty, `.` or `..` segment';
  return undefined;
}

function unsafeContentReason(content: string): string | undefined {
  if (content.includes('\0')) return 'NUL byte in content';
  if (!content.isWellFormed()) return 'lone Unicode surrogate in content';
  return undefined;
}

function validateEntry(
  entry: FileBundleEntry,
  input: ParseFileBundleInput,
  targets: Map<string, BundleBaseline>,
  seen: Set<string>,
): ParseFileBundleResult | undefined {
  const { path } = entry;
  const unsafePath = unsafePathReason(path);
  if (unsafePath !== undefined) return rejected('unsafe-target', `${path}: ${unsafePath}`);
  if (seen.has(path)) return rejected('unsafe-target', `${path}: duplicate entry`);
  for (const other of seen) {
    if (path.startsWith(`${other}/`) || other.startsWith(`${path}/`)) {
      return rejected('unsafe-target', `${path}: collides with declared target ${other}`);
    }
  }

  const target = targets.get(path);
  if (target === undefined) {
    return rejected('unsafe-target', `${path}: not a declared target of this brief`);
  }
  if (!isInDeclaredSet(path, input.scope)) {
    return rejected('unsafe-target', `${path}: outside the brief's declared scope`);
  }
  if (entry.action !== target.operation) {
    return rejected(
      'invalid-bundle',
      `${path}: response says ${entry.action} but the captured baseline is ${target.operation}`,
    );
  }

  const unsafeContent = unsafeContentReason(entry.content);
  if (unsafeContent !== undefined) return rejected('invalid-bundle', `${path}: ${unsafeContent}`);
  const bytes = Buffer.byteLength(entry.content, 'utf8');
  if (bytes > FILE_BUNDLE_MAX_FILE_BYTES) {
    return rejected(
      'output-limit',
      `${path}: ${bytes} bytes of content exceeds the ${FILE_BUNDLE_MAX_FILE_BYTES}-byte file limit`,
    );
  }
  return undefined;
}

/**
 * The `file-bundle-v1` whole-response parser: pure over the text, the captured
 * targets and the brief's scope. Every entry is validated before any candidate
 * is returned, so one bad entry leaves nothing applicable. An omitted target is
 * untouched, never deleted; a modify entry equal to its baseline is a no-op,
 * and a bundle of nothing but no-ops is the existing no-change failure. A
 * blocked response asks for files and applies nothing.
 */
export function parseFileBundle(input: ParseFileBundleInput): ParseFileBundleResult {
  if (input.status !== 'completed') {
    return rejected(
      'invalid-bundle',
      `response did not complete: transport status ${input.status}`,
    );
  }
  const responseBytes = Buffer.byteLength(input.text, 'utf8');
  if (responseBytes > FILE_BUNDLE_MAX_RESPONSE_BYTES) {
    return rejected(
      'output-limit',
      `response of ${responseBytes} bytes exceeds the ${FILE_BUNDLE_MAX_RESPONSE_BYTES}-byte limit`,
    );
  }

  const unwrapped = unwrapBundleText(input.text);
  if ('error' in unwrapped) return rejected('invalid-bundle', unwrapped.error);
  let raw: unknown;
  try {
    raw = JSON.parse(unwrapped.json);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return rejected('invalid-bundle', `response is not valid JSON: ${message}`);
  }
  const bundle = FileBundleSchema.safeParse(raw);
  if (!bundle.success) {
    return rejected(
      'invalid-bundle',
      `response does not match file-bundle-v1: ${bundle.error.message}`,
    );
  }
  if ('blocked' in bundle.data) {
    return {
      kind: 'blocked',
      question: bundle.data.blocked.question,
      filesNeeded: bundle.data.blocked.filesNeeded,
    };
  }

  const targets = new Map(input.targets.map((target) => [target.path, target]));
  const seen = new Set<string>();
  for (const entry of bundle.data.files) {
    const failure = validateEntry(entry, input, targets, seen);
    if (failure !== undefined) return failure;
    seen.add(entry.path);
  }

  const candidates: FileBundleCandidate[] = [];
  const noops: string[] = [];
  for (const entry of bundle.data.files) {
    const target = targets.get(entry.path);
    if (target?.operation === 'modify' && target.content === entry.content) {
      noops.push(entry.path);
      continue;
    }
    candidates.push({ path: entry.path, action: entry.action, content: entry.content });
  }
  if (candidates.length === 0) {
    return rejected('no-changes', 'every declared target already holds the response content');
  }

  candidates.sort((left, right) => byPath(left.path, right.path));
  return {
    kind: 'parsed',
    candidates,
    noops: noops.sort(byPath),
    untouched: [...targets.keys()].filter((path) => !seen.has(path)).sort(byPath),
  };
}
