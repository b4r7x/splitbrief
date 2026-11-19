import { readConfinedEntry } from '../../orchestrator/approval/file-snapshots/entry/read.js';
import { PATH_MAX_LENGTH } from './mentions.js';

const BACKTICK_RUN_RE = /`+/g;

type SourceRead =
  | { kind: 'text'; content: string; sha256: string }
  | { kind: 'missing' }
  | { kind: 'unsupported' };

/** Strict: an invalid sequence throws instead of decoding to U+FFFD. */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A symlink, directory, special file, binary payload or invalid UTF-8 is
 * unsupported — never silently absent and never silently repaired. */
export async function readSource(projectDir: string, path: string): Promise<SourceRead> {
  if (
    path.length === 0 ||
    path.length > PATH_MAX_LENGTH ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\\') ||
    path.includes('\u0000') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    return { kind: 'unsupported' };
  let entry: Awaited<ReturnType<typeof readConfinedEntry>>;
  try {
    entry = await readConfinedEntry(projectDir, path);
  } catch {
    return { kind: 'unsupported' };
  }
  if (entry.kind === 'absent') return { kind: 'missing' };
  if (entry.bytes.includes(0)) return { kind: 'unsupported' };
  try {
    return { kind: 'text', content: utf8.decode(entry.bytes), sha256: entry.sha256 };
  } catch {
    return { kind: 'unsupported' };
  }
}

function fenceFor(content: string): string {
  let longest = 2;
  for (const run of content.match(BACKTICK_RUN_RE) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(longest + 1);
}

export function sourceBlock(heading: string, content: string): string {
  const fence = fenceFor(content);
  return `### ${heading}\n${fence}\n${content}\n${fence}`;
}
