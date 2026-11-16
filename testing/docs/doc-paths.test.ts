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
const SRC_FOLDERS = readdirSync(join(ROOT, 'src'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
// A path with no `src/` prefix starts a word with a folder of `src/` (`core/state/machine.ts`).
const LAYER_PATH = new RegExp(
  `(?<=^|[^\\w./~@$-])(?:${SRC_FOLDERS.join('|')})\\/(?:[\\w./@*…-]|<[^>\\s]*>|\\[[^\\]\\s]*\\]|\\{[^}\\s]*\\})*`,
  'g',
);
// A `hooks/` or `components/` path can be relative to a feature folder.
const FEATURE_RELATIVE = new Set(['hooks', 'components']);
const FEATURES = readdirSync(join(ROOT, 'src', 'features'));

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

// A token with no extension, no trailing slash and no brace list is a path only when its first two
// segments name a folder of `src/`; otherwise it is a phrase such as `engine/UI` or `cli/shell/agent`.
function namesLayerPath(path: string): boolean {
  if (extname(path) !== '' || path.endsWith('/') || path.includes(',')) return true;
  const [layer, folder] = path.split('/');
  return folder !== undefined && existsSync(join(ROOT, 'src', layer ?? '', folder));
}

function layerPathExists(path: string): boolean {
  if (exists(`src/${path}`)) return true;
  const layer = path.replace(/\/.*/, '');
  return (
    FEATURE_RELATIVE.has(layer) &&
    FEATURES.some((feature) => exists(`src/features/${feature}/${path}`))
  );
}

function stalePaths(line: string): string[] {
  const srcPaths = [...line.matchAll(SRC_PATH)]
    .map((match) => match[0])
    .filter((path) => !PLACEHOLDER.test(path))
    .map((path) => path.replace(/\.+$/, ''))
    .filter((path) =>
      expandBraces(path).some((expanded) => isRepoPath(expanded) && !exists(expanded)),
    );
  const layerPaths = [...line.matchAll(LAYER_PATH)]
    .map((match) => match[0])
    .filter((path) => !PLACEHOLDER.test(path))
    .map((path) => path.replace(/\.+$/, ''))
    .filter(
      (path) =>
        namesLayerPath(path) && expandBraces(path).some((expanded) => !layerPathExists(expanded)),
    );
  return [...srcPaths, ...layerPaths];
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

  it('names a path with no src prefix under a folder of this repository that does not exist', () => {
    expect(stalePaths('See `core/no-such-file.ts` and `features/workflow/no-such-panel`.')).toEqual(
      ['core/no-such-file.ts', 'features/workflow/no-such-panel'],
    );
  });

  it('passes a path with no src prefix that exists, also relative to a feature folder', () => {
    expect(
      stalePaths('`core/state/machine.ts` and `hooks/workflow-screen/use-model.ts` exist.'),
    ).toEqual([]);
  });

  it('reads a slash phrase whose first two segments name no folder as words', () => {
    expect(stalePaths('The `engine/UI` boundary and the `cli/shell/agent` kinds.')).toEqual([]);
  });
});
