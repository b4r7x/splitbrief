import { z } from 'zod';
import { FileActionSchema } from '../../../core/schemas/enums.js';
import {
  TASK_BRIEF_COMPILER_POLICY,
  type TaskCompilationPolicy,
} from '../../../core/schemas/task-compilation.js';
import { formatTaskId, type TaskId } from '../../../core/schemas/task.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { error } from '../../../utils/error.js';
import { sha256Hex } from '../../../utils/sha256.js';

const MANIFEST_VERSION = 1 as const;
const MAX_PURPOSE_BYTES = 16 * 1_024;
const PATH_RE = /^(?:`([^`\r\n]+)`|([^\s`]+))$/;
const FILE_ENTRY_RE = /^\s*-\s*(.*?)\s*$/;
const PURPOSE_RE = /^(?:\s{2,}|\t+)(?:Purpose\s*:\s*)?(.*?)\s*$/i;
const TOP_LEVEL_HEADING_RE = /^#{1,2}\s+/;
const SUBHEADING_RE = /^###\s+(.+?)\s*$/;

export type TaskManifestAction = 'create' | 'modify';

export type TaskManifestItem = Readonly<{
  ordinal: number;
  id: TaskId;
  action: TaskManifestAction;
  file: string;
  purpose: string;
}>;

export type TaskManifest = Readonly<{
  version: typeof MANIFEST_VERSION;
  policyVersion: TaskCompilationPolicy['version'];
  items: readonly TaskManifestItem[];
  manifestDigest: string;
}>;

export const TaskManifestItemSchema = z
  .strictObject({
    ordinal: z.number().int().nonnegative(),
    id: z.string().regex(/^T\d{3}$/),
    action: FileActionSchema,
    file: z.string().min(1),
    purpose: z.string().min(1).max(MAX_PURPOSE_BYTES),
  })
  .readonly();

export const TaskManifestSchema = z
  .strictObject({
    version: z.literal(MANIFEST_VERSION),
    policyVersion: z.literal(TASK_BRIEF_COMPILER_POLICY.version),
    items: z.array(TaskManifestItemSchema).max(TASK_BRIEF_COMPILER_POLICY.maxManifestItems),
    manifestDigest: z.string().regex(/^manifest-[a-f0-9]{64}$/),
  })
  .readonly();

export const taskManifestError = {
  invalid: (detail: string) =>
    error('task_compiler_manifest_invalid', `Invalid task manifest: ${detail}`, { detail }),
  empty: () => error('task_compiler_manifest_empty', 'The plan File Structure contains no files.'),
  capacity: (count: number, limit: number) =>
    error(
      'task_compiler_capacity_exceeded',
      `The task manifest contains ${count} items; the V1 limit is ${limit}.`,
      { count, limit },
    ),
} as const;

type ParsedEntry = {
  action: TaskManifestAction;
  file: string;
  purpose: string[];
};

type ManifestEntryInput = Readonly<{
  action: TaskManifestAction;
  file: string;
  purpose: string;
}>;

export function parseTaskManifest(
  plan: string,
  policy: TaskCompilationPolicy = TASK_BRIEF_COMPILER_POLICY,
): TaskManifest {
  const lines = plan.split(/\r?\n/);
  const start = findFileStructureHeading(lines);
  if (start === -1) throw taskManifestError.invalid('missing exact `## File Structure` heading');

  const section = readFileStructureSection(lines, start + 1);
  const entries = parseEntries(section);
  return createTaskManifest(entries, policy);
}

export function createTaskManifest(
  input: readonly ManifestEntryInput[],
  policy: TaskCompilationPolicy = TASK_BRIEF_COMPILER_POLICY,
): TaskManifest {
  if (input.length === 0) throw taskManifestError.empty();
  if (input.length > policy.maxManifestItems) {
    throw taskManifestError.capacity(input.length, policy.maxManifestItems);
  }

  const seenFiles = new Set<string>();
  const items: TaskManifestItem[] = [];
  for (let ordinal = 0; ordinal < input.length; ordinal++) {
    const entry = input[ordinal];
    if (entry === undefined) throw taskManifestError.invalid(`missing entry at ${ordinal}`);
    const file = validateFilePath(entry.file);
    const purpose = validatePurpose(entry.purpose);
    if (seenFiles.has(file)) throw taskManifestError.invalid(`duplicate file: ${file}`);
    seenFiles.add(file);

    const action = FileActionSchema.safeParse(entry.action);
    if (!action.success) throw taskManifestError.invalid(`invalid action for ${file}`);
    items.push({ ordinal, id: formatTaskId(ordinal + 1), action: action.data, file, purpose });
  }

  const frozenItems = Object.freeze(items.map((item) => Object.freeze(item)));
  const manifestDigest = digestManifest(policy.version, frozenItems);
  const manifest: TaskManifest = {
    version: MANIFEST_VERSION,
    policyVersion: policy.version,
    items: frozenItems,
    manifestDigest,
  };
  return Object.freeze(manifest);
}

export function digestManifest(
  policyVersion: TaskCompilationPolicy['version'],
  items: readonly TaskManifestItem[],
): string {
  return `manifest-${sha256Hex(
    `task-brief-manifest\u0000${canonicalJSON({
      version: MANIFEST_VERSION,
      policyVersion,
      items,
    })}`,
  )}`;
}

function findFileStructureHeading(lines: readonly string[]): number {
  let match = -1;
  for (let index = 0; index < lines.length; index++) {
    if (/^##\s+File Structure\s*$/.test(lines[index] ?? '')) {
      if (match !== -1) throw taskManifestError.invalid('duplicate `## File Structure` heading');
      match = index;
    }
  }
  return match;
}

function readFileStructureSection(lines: readonly string[], start: number): readonly string[] {
  const section: string[] = [];
  for (let index = start; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (TOP_LEVEL_HEADING_RE.test(line)) break;
    section.push(line);
  }
  return section;
}

function parseEntries(lines: readonly string[]): readonly ManifestEntryInput[] {
  const entries: ParsedEntry[] = [];
  const sections = new Set<TaskManifestAction>();
  let action: TaskManifestAction | null = null;
  let pending: ParsedEntry | null = null;

  const finishPending = () => {
    if (pending === null) return;
    if (pending.purpose.length === 0) {
      throw taskManifestError.invalid(`missing indented purpose for ${pending.file}`);
    }
    entries.push(pending);
    pending = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const heading = SUBHEADING_RE.exec(line)?.[1];
    if (heading !== undefined) {
      finishPending();
      action = actionForHeading(heading);
      if (action === null)
        throw taskManifestError.invalid(`unsupported File Structure heading: ${heading}`);
      if (sections.has(action)) throw taskManifestError.invalid(`duplicate ${heading} section`);
      sections.add(action);
      continue;
    }
    if (/^#{3,}\s+/.test(line) || /^##?\s*$/.test(line)) {
      throw taskManifestError.invalid(`unsupported File Structure heading: ${trimmed}`);
    }
    if (action === null)
      throw taskManifestError.invalid(`entry appears outside a file section: ${trimmed}`);

    const entryMatch = FILE_ENTRY_RE.exec(line);
    if (entryMatch?.[1] !== undefined && !line.startsWith(' ') && !line.startsWith('\t')) {
      finishPending();
      const parsedPath = parseEntryPath(entryMatch[1]);
      pending = { action, file: parsedPath, purpose: [] };
      continue;
    }
    if (pending === null) throw taskManifestError.invalid(`unexpected content: ${trimmed}`);
    if (/^(?:\s{2,}|\t+)[-*](?:\s|$)/.test(line)) {
      throw taskManifestError.invalid(`indented bullet is not a valid purpose for ${pending.file}`);
    }
    const purpose = PURPOSE_RE.exec(line)?.[1];
    if (purpose === undefined || purpose.trim() === '') {
      throw taskManifestError.invalid(
        `purpose must be an indented non-empty line for ${pending.file}`,
      );
    }
    pending.purpose.push(purpose.trim());
  }
  finishPending();

  if (!sections.has('create') || !sections.has('modify')) {
    throw taskManifestError.invalid(
      'both `### New Files` and `### Modified Files` sections are required',
    );
  }
  if (entries.length === 0) throw taskManifestError.empty();
  return entries.map((entry) => ({
    action: entry.action,
    file: entry.file,
    purpose: entry.purpose.join('\n'),
  }));
}

function actionForHeading(heading: string): TaskManifestAction | null {
  if (heading === 'New Files') return 'create';
  if (heading === 'Modified Files') return 'modify';
  return null;
}

function parseEntryPath(raw: string): string {
  const match = PATH_RE.exec(raw.trim());
  if (match === null) throw taskManifestError.invalid(`file entry must contain one path: ${raw}`);
  const file = (match[1] ?? match[2] ?? '').trim();
  return validateFilePath(file);
}

function validateFilePath(file: string): string {
  const normalized = file.trim();
  if (
    normalized === '' ||
    normalized.includes('\\') ||
    normalized.includes('\u0000') ||
    normalized.startsWith('/') ||
    normalized.startsWith('~') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.startsWith('./') ||
    normalized.endsWith('/')
  ) {
    throw taskManifestError.invalid(`file path is not project-relative: ${file}`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw taskManifestError.invalid(`file path contains an unsafe segment: ${file}`);
  }
  return normalized;
}

function validatePurpose(purpose: string): string {
  const normalized = purpose.trim();
  if (normalized === '') throw taskManifestError.invalid('file purpose must not be empty');
  if (Buffer.byteLength(normalized, 'utf8') > MAX_PURPOSE_BYTES) {
    throw taskManifestError.invalid('file purpose exceeds its bounded size');
  }
  return normalized;
}
