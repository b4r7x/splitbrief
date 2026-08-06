import { readFile } from 'node:fs/promises';
import type { Task } from '../../core/schemas/task.js';
import { validateTaskPath } from '../../core/paths-io.js';
import { writeConfinedSecureFileAsync } from '../../lib/fs.js';
import { isENOENT } from '../../lib/process/errors.js';
import { toErrorMessage } from '../../utils/format-errors.js';

const searchReplaceRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)=======\r?\n([\s\S]*?)>>>>>>> REPLACE/g;
// Line-anchored: a whole-file rewrite that merely mentions the token inside a string or regex
// literal is still written, while a response that opens a patch block must complete it.
const openingMarkerRegex = /^<<<<<<< SEARCH/m;

export async function applyCode(
  code: string,
  task: Task,
  projectDir: string,
): Promise<{ success: boolean; error?: string }> {
  let filePath: string;
  try {
    filePath = validateTaskPath(projectDir, task.file);
  } catch (err) {
    return { success: false, error: toErrorMessage(err) };
  }

  if (task.action === 'create') {
    await writeConfinedSecureFileAsync(projectDir, task.file, code);
    return { success: true };
  }

  let existing: string;
  try {
    existing = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (!isENOENT(err)) throw err;
    await writeConfinedSecureFileAsync(projectDir, task.file, code);
    return { success: true };
  }

  const matches = findPatchBlocks(code);

  if (matches.length === 0) {
    const markerIndex = code.search(openingMarkerRegex);
    if (markerIndex !== -1) {
      return {
        success: false,
        error:
          `Malformed SEARCH/REPLACE block in ${task.file}: nothing was written because a block opens with ` +
          '<<<<<<< SEARCH but never closes with ======= and >>>>>>> REPLACE:\n' +
          code.slice(markerIndex, markerIndex + 200),
      };
    }
    await writeConfinedSecureFileAsync(projectDir, task.file, code);
    return { success: true };
  }

  const fileEnding = existing.includes('\r\n') ? '\r\n' : '\n';
  let result = existing;

  for (const match of matches) {
    // trimEnd makes matches resilient to trailing whitespace models commonly emit before the delimiter.
    const search = (match[1] ?? '').trimEnd();
    const replace = (match[2] ?? '').trimEnd();

    const matched = locateSearchBlock(result, search);
    if (matched.kind === 'not-found') {
      return {
        success: false,
        error:
          `Search block not found in ${task.file} (checked both raw and line-ending-normalized content):\n` +
          search.slice(0, 200),
      };
    }
    if (matched.kind === 'ambiguous') {
      return {
        success: false,
        error: `ambiguous search block (${matched.occurrences} matches) in ${task.file}:\n${search.slice(0, 200)}`,
      };
    }

    result =
      result.slice(0, matched.index) +
      matched.replace(replace) +
      result.slice(matched.index + matched.length);
  }

  await writeConfinedSecureFileAsync(projectDir, task.file, restoreEnding(result, fileEnding));
  return { success: true };
}

export function hasApplicablePatch(code: string): boolean {
  return findPatchBlocks(code).length > 0;
}

// matchAll leaves the shared global regex's lastIndex alone; test/exec would not.
function findPatchBlocks(code: string): RegExpExecArray[] {
  return [...code.matchAll(searchReplaceRegex)];
}

type SearchMatch =
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; occurrences: number }
  | { kind: 'found'; index: number; length: number; replace: (replacement: string) => string };

// Locates a search block, retrying against LF-normalized content when the raw
// match fails so CRLF code can patch LF files (and vice versa). A normalized
// match maps the LF offset back onto the original content, and the replacement
// is re-applied with the original ending so the rest of the file is untouched.
function locateSearchBlock(content: string, search: string): SearchMatch {
  const direct = locateExact(content, search);
  if (direct.kind !== 'not-found') return direct;

  const normalizedContent = toLf(content);
  const normalizedSearch = toLf(search);
  const viaNormalized = locateExact(normalizedContent, normalizedSearch);
  if (viaNormalized.kind !== 'found') return viaNormalized;

  // Map the LF offset/length back onto the original content by counting CRLFs.
  const index = denormalizeOffset(content, viaNormalized.index);
  const end = denormalizeOffset(content, viaNormalized.index + viaNormalized.length);
  return {
    kind: 'found',
    index,
    length: end - index,
    replace: (replacement) =>
      content.slice(index, end).includes('\r\n')
        ? replacement.replaceAll('\n', '\r\n')
        : replacement,
  };
}

function locateExact(content: string, search: string): SearchMatch {
  const firstIndex = content.indexOf(search);
  if (firstIndex === -1) return { kind: 'not-found' };
  if (content.indexOf(search, firstIndex + search.length) !== -1) {
    return { kind: 'ambiguous', occurrences: content.split(search).length - 1 };
  }
  return { kind: 'found', index: firstIndex, length: search.length, replace: (r) => r };
}

function toLf(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

function denormalizeOffset(original: string, lfOffset: number): number {
  let lf = 0;
  let pos = 0;
  while (lf < lfOffset && pos < original.length) {
    if (original.startsWith('\r\n', pos)) pos += 2;
    else pos += 1;
    lf += 1;
  }
  return pos;
}

function restoreEnding(content: string, ending: '\r\n' | '\n'): string {
  return ending === '\r\n' ? toLf(content).replaceAll('\n', '\r\n') : content;
}
