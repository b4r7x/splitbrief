import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const ROOT_DOCS = ['README.md', 'CONTRIBUTING.md', 'CLAUDE.md', 'AGENTS.md'];

// A `src/` path starts a word, follows `./` or `../` in a relative link, or follows the ref of a
// GitHub link to this repository. `website/src/` or `~/app/src/` is the path of another tree.
const SRC_PATH =
  /(?<=^|[^\w./-]|(?:^|[^\w.-])\.\.?\/|github\.com\/b4r7x\/splitbrief\/(?:blob|tree)\/[^/\s]+\/)src\/(?:[\w./@*…-]|<[^>\s]*>|\[[^\]\s]*\]|\{[^}\s]*\})*/g;
const PLACEHOLDER = /[<*…[]|\.\.\.|\{[^,}]*\}/;
const SRC_ENTRIES = new Set(readdirSync(join(ROOT, 'src')));

function docFiles(): string[] {
  const nested = readdirSync(join(ROOT, 'docs'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)));
  return [...nested, ...ROOT_DOCS].sort();
}

function expandBraces(path: string): string[] {
  const brace = /\{[^{}]*\}/.exec(path);
  if (brace === null) return [path];
  return brace[0]
    .slice(1, -1)
    .split(',')
    .flatMap((part) => expandBraces(path.replace(brace[0], part)));
}

function exists(path: string): boolean {
  const target = join(ROOT, path);
  if (existsSync(target)) return true;
  const extension = extname(path);
  if (extension !== '' && extension !== '.js') return false;
  const stem = extension === '.js' ? target.slice(0, -3) : target;
  return existsSync(`${stem}.ts`) || existsSync(`${stem}.tsx`);
}

// A first segment that names no entry of this repository's `src/` is a path of another project.
function isRepoPath(path: string): boolean {
  const first = path.slice('src/'.length).replace(/\/.*/, '');
  if (SRC_ENTRIES.has(first)) return true;
  return (
    extname(first) === '' && (SRC_ENTRIES.has(`${first}.ts`) || SRC_ENTRIES.has(`${first}.tsx`))
  );
}

function stalePaths(line: string): string[] {
  return [...line.matchAll(SRC_PATH)]
    .map((match) => match[0])
    .filter((path) => !PLACEHOLDER.test(path))
    .map((path) => path.replace(/\.+$/, ''))
    .filter((path) =>
      expandBraces(path).some((expanded) => isRepoPath(expanded) && !exists(expanded)),
    );
}

function docEntries(doc: string): string[] {
  const lines = readFileSync(join(ROOT, doc), 'utf8').split('\n');
  return lines.flatMap((line, index) =>
    stalePaths(line).map((path) => `${doc}:${index + 1}: ${path}`),
  );
}

describe('src paths in the docs', () => {
  it('names only a path that exists or an example with a placeholder', () => {
    expect(docFiles().flatMap(docEntries)).toEqual([]);
  });

  it('skips the path of a file in another project', () => {
    expect(stalePaths('Edit `src/app.ts` in your project.')).toEqual([]);
  });

  it('names a path under a folder of this repository that does not exist', () => {
    expect(stalePaths('See `src/core/no-such-file.ts`.')).toEqual(['src/core/no-such-file.ts']);
  });

  it('passes a path of this repository that exists', () => {
    expect(stalePaths('The CLI starts in `src/cli.ts`.')).toEqual([]);
  });
});
