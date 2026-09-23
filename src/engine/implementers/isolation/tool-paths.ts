import { resolve } from 'node:path';
import { isRecord } from '../../../utils/type-guards.js';
import {
  readShellCommand,
  type PathAccess,
  type PathReference,
  type PathScope,
  type ShellReading,
} from './shell-paths.js';

export type ToolUse = Readonly<{ name: string; input: Readonly<Record<string, unknown>> }>;

// Input keys compare lowercased with `_` and `-` removed, so `file_path`, `filePath`,
// `TargetFile` and `DirectoryPath` all read as one vocabulary across the tools.
const COMMAND_KEYS = new Set(['command', 'commandline', 'cmd', 'script']);
const CWD_KEYS = new Set(['cwd', 'workdir', 'workingdirectory', 'workingdir']);
const PATH_KEY = /(?:path|paths|file|files|filename|dir|dirs|directory|directories|folder|root)$/;
const GLOB_KEYS = new Set(['pattern', 'globpattern', 'glob']);

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[_-]/g, '');
}

/**
 * How a tool reaches the paths its input names, read off its name: every tool
 * spells its file tools differently (`Write`, `write_to_file`, `file_change`),
 * but each says what it does.
 */
function toolAccess(name: string): PathAccess {
  const lower = name.toLowerCase();
  if (
    /write|edit|create|replace|delete|remove|move|rename|mkdir|patch|file_change|insert|sed_file/.test(
      lower,
    )
  ) {
    return 'write';
  }
  if (/grep|glob|find|search/.test(lower)) return 'search';
  if (/(?:^|_)ls$|^ls|list/.test(lower)) return 'list';
  return 'read';
}

function commandText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(' ');
  }
  return null;
}

function pathValues(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

/** The fixed prefix of an absolute glob: `/Users/me/src/*.ts` searches `/Users/me/src`. */
function globRoot(pattern: string): string | null {
  if (!pattern.startsWith('/') && !pattern.startsWith('~')) return null;
  const cut = pattern.search(/[*?[{]/);
  const fixed = cut === -1 ? pattern : pattern.slice(0, cut);
  return fixed === '' ? null : fixed;
}

function expandHome(path: string, home: string): string {
  return path === '~' || path.startsWith('~/') ? `${home}${path.slice(1)}` : path;
}

/**
 * The input text a tool use names its paths with: the command line of a shell
 * tool, otherwise its path-keyed values — never the content a write carries.
 */
export function toolUseInputText(toolUse: ToolUse): string {
  const entries = Object.entries(toolUse.input).map(
    ([key, value]) => [normalizedKey(key), value] as const,
  );
  const command = entries.find(([key]) => COMMAND_KEYS.has(key));
  if (command !== undefined) return commandText(command[1]) ?? '';
  return entries
    .flatMap(([key, value]) => (PATH_KEY.test(key) || GLOB_KEYS.has(key) ? pathValues(value) : []))
    .join(' ');
}

/**
 * Every path one tool use reaches. File tools name their paths under keys the
 * vocabulary above recognises; a shell tool's command line is read by
 * `readShellCommand` from the directory the tool says it runs in, and the
 * directory its `cd` leaves the shell in is the reading's `cwd`.
 */
export function readToolUse(toolUse: ToolUse, scope: PathScope): ShellReading {
  const references: PathReference[] = [];
  const access = toolAccess(toolUse.name);
  const searches = /glob|find/.test(toolUse.name.toLowerCase());
  const add = (path: string, how: PathAccess, base: string) =>
    references.push({
      path: resolve(base, expandHome(path, scope.home)),
      access: how,
      followsLink: true,
    });

  let cwd = scope.cwd;
  let shellCwd: string | undefined;
  for (const [key, value] of Object.entries(toolUse.input)) {
    if (!CWD_KEYS.has(normalizedKey(key)) || typeof value !== 'string' || value === '') continue;
    add(value, 'read', scope.cwd);
    cwd = resolve(scope.cwd, expandHome(value, scope.home));
  }

  const visit = (record: Readonly<Record<string, unknown>>, nested: boolean) => {
    for (const [key, value] of Object.entries(record)) {
      const normalized = normalizedKey(key);
      const command = COMMAND_KEYS.has(normalized) ? commandText(value) : null;
      if (command !== null) {
        const reading = readShellCommand(command, { ...scope, cwd });
        references.push(...reading.references);
        shellCwd = reading.cwd;
      } else if (!CWD_KEYS.has(normalized) && PATH_KEY.test(normalized)) {
        for (const path of pathValues(value)) add(path, access, cwd);
      } else if (GLOB_KEYS.has(normalized) && searches && typeof value === 'string') {
        const root = globRoot(value);
        if (root !== null) add(root, 'search', cwd);
      } else if (!nested && Array.isArray(value)) {
        // codex's `file_change` lists its paths as `changes: [{ path, kind }]`.
        for (const item of value) if (isRecord(item)) visit(item, true);
      }
    }
  };
  visit(toolUse.input, false);
  return { references, cwd: shellCwd ?? scope.cwd };
}
