import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { namesListedIn } from '../../../lib/fs.js';
import { isPathConfined } from '../../../lib/path-confinement.js';
import { isNodeError } from '../../../lib/process/errors.js';
import { isTestFile, STACKS } from '../../../core/validation/stacks/registry.js';
import { isRecord } from '../../../utils/type-guards.js';
import { collectTrackedFiles } from '../../snapshots/files.js';
import { createRunBaseReader, type RunBaseFile } from '../isolation/acquisition.js';
import type { RunBase } from '../isolation/base-tree.js';
import { type CheckDefinition, checkDefinition } from './reviewer-command-policy.js';

/** Composer's own `@` commands, which name no script. */
const COMPOSER_COMMANDS = new Set(['php', 'composer', 'putenv']);

type BaseReader = (file: string) => Promise<RunBaseFile>;
type PackageScript = Extract<CheckDefinition, { kind: 'package-script' }>;
type TaskFile = Extract<CheckDefinition, { kind: 'task-file' | 'wrapper' }>;
type Manifest = { scripts: Record<string, unknown>; aliases: string | undefined };

/**
 * A package.json runner can run `pre<script>` and `post<script>` around a script (npm, yarn classic,
 * bun, pnpm with `enable-pre-post-scripts`), so they are compared as part of what it runs.
 */
function scriptsRun(definition: PackageScript): string[] {
  const { manifest, script } = definition;
  return manifest === 'package.json' ? [`pre${script}`, script, `post${script}`] : [script];
}

/**
 * A test file by a registry stack's test pattern or test directory. Running a test is what a
 * review is for, so a test this run wrote or changed is not a check definition.
 */
function isTestScript(file: string): boolean {
  const dirs = file.split('/').slice(0, -1);
  return STACKS.some(
    (stack) => isTestFile(file, stack) || stack.testDirs.some((dir) => dirs.includes(dir)),
  );
}

async function orNoFiles<T>(listing: Promise<T[]>): Promise<T[]> {
  try {
    return await listing;
  } catch (err: unknown) {
    if (isNodeError(err) && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return [];
    throw err;
  }
}

/** Each named file the workspace holds under its exact name, in its own parent directory. */
async function filesPresent(workspaceDir: string, files: readonly string[]): Promise<string[]> {
  const present: string[] = [];
  for (const file of files) {
    const parent = join(workspaceDir, posix.dirname(file));
    const listed = await orNoFiles(namesListedIn(parent, [posix.basename(file)]));
    if (listed.length > 0) present.push(file);
  }
  return present;
}

/**
 * Every file under a directory, ignored ones too: a wrapper jar or compiled downloader is part of what runs. A
 * symbolic link is kept, and the comparison reads the file it names.
 */
async function filesUnder(workspaceDir: string, dir: string): Promise<string[]> {
  const entries = await orNoFiles(
    readdir(join(workspaceDir, dir), { recursive: true, withFileTypes: true, encoding: 'utf8' }),
  );
  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => relative(workspaceDir, join(entry.parentPath, entry.name)))
    .sort();
}

/** The first of the directories, or of their parents, that is a symbolic link, or undefined. */
async function linkedDir(
  workspaceDir: string,
  dirs: readonly string[],
): Promise<string | undefined> {
  for (const dir of dirs) {
    const segments = dir.split('/');
    for (let count = 1; count <= segments.length; count++) {
      const path = segments.slice(0, count).join('/');
      const [entry] = await orNoFiles(lstat(join(workspaceDir, path)).then((stats) => [stats]));
      if (entry === undefined) break;
      if (entry.isSymbolicLink()) return path;
    }
  }
  return undefined;
}

async function taskFileRefusal(
  definition: TaskFile,
  read: BaseReader,
  workspaceDir: string,
): Promise<string | null> {
  const link = await linkedDir(workspaceDir, definition.dirs);
  if (link !== undefined) return `runs ${definition.runner} on ${link}, which is a symbolic link`;
  const files = [
    ...(await filesPresent(workspaceDir, definition.files)),
    ...(await Promise.all(definition.dirs.map((dir) => filesUnder(workspaceDir, dir)))).flat(),
  ];
  for (const file of files) {
    const atBase = await read(file);
    if (atBase.kind === 'changed') {
      return `runs ${definition.runner} on ${file}, which this run changed`;
    }
    if (atBase.kind === 'new') {
      return `runs ${definition.runner} on ${file}, which the run base does not hold`;
    }
  }
  return null;
}

function parseManifest(text: string | null): Manifest | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return { scripts: {}, aliases: undefined };
    return {
      scripts: isRecord(parsed['scripts']) ? parsed['scripts'] : {},
      aliases: JSON.stringify(parsed['scripts-aliases']),
    };
  } catch {
    return null;
  }
}

async function workspaceText(workspaceDir: string, file: string): Promise<string | null> {
  try {
    return await readFile(join(workspaceDir, file), 'utf8');
  } catch {
    return null;
  }
}

/** Composer runs the scripts an `@name` entry names, before or after the run, so they are run too. */
function scriptsReached(definition: PackageScript, before: Manifest, after: Manifest): string[] {
  const reached = new Set(scriptsRun(definition));
  if (definition.manifest !== 'composer.json') return [...reached];
  // A Set iterator also visits the names added while it runs.
  for (const name of reached) {
    for (const value of [before.scripts[name], after.scripts[name]]) {
      const entries: unknown[] = Array.isArray(value) ? value : [value];
      for (const entry of entries) {
        if (typeof entry !== 'string' || !entry.startsWith('@')) continue;
        const [reference] = entry.slice(1).split(/\s+/);
        if (reference !== undefined && reference !== '' && !COMPOSER_COMMANDS.has(reference)) {
          reached.add(reference);
        }
      }
    }
  }
  return [...reached];
}

async function manifestRefusal(
  definition: PackageScript,
  file: string,
  read: BaseReader,
  workspaceDir: string,
): Promise<string | null> {
  const { script } = definition;
  const atBase = await read(file);
  if (atBase.kind === 'absent' || atBase.kind === 'unchanged') return null;
  if (atBase.kind === 'new') {
    return `runs the package script ${script}, and the run base does not hold ${file}`;
  }
  const before = parseManifest(atBase.text);
  const after = parseManifest(await workspaceText(workspaceDir, file));
  if (before === null || after === null) {
    return `runs the package script ${script}, and this run changed ${file}`;
  }
  if (definition.manifest === 'composer.json' && before.aliases !== after.aliases) {
    return `runs the package script ${script}, and this run changed scripts-aliases in ${file}`;
  }
  const changed = scriptsReached(definition, before, after).find(
    (name) => JSON.stringify(before.scripts[name]) !== JSON.stringify(after.scripts[name]),
  );
  if (changed === undefined) return null;
  const where = file === definition.manifest ? '' : ` in ${file}`;
  return changed === script
    ? `runs the package script ${changed}, which this run changed${where}`
    : `runs the package script ${script} with its ${changed} script, which this run changed${where}`;
}

/**
 * The manifest in the directory a directory option names, then every manifest of the definition's
 * name in the workspace, the root one too when the run deleted it. A manifest under a test
 * directory is a fixture, not a package that runs the script, unless a directory option names it.
 */
async function manifestsOf(
  definition: PackageScript,
  base: RunBase,
  workspaceDir: string,
): Promise<string[]> {
  const listed = await collectTrackedFiles(workspaceDir, { ignoreProjectDir: base.projectDir });
  const manifests = listed.filter(
    (file) => posix.basename(file) === definition.manifest && !isTestScript(file),
  );
  const named = posix.join(definition.dir, definition.manifest);
  return [...new Set([named, definition.manifest, ...manifests])];
}

/**
 * A command whose package script, task file or interpreter script this run changed or created
 * runs code the run wrote, not the project's own check, so it is refused. Null when the definition
 * is the one the run started from. With no run base only a wrapper is refused: its files are the
 * build tool itself.
 */
export async function changedDefinitionRefusal(input: {
  command: string;
  base: RunBase | undefined;
  workspaceDir: string;
}): Promise<string | null> {
  const { base, workspaceDir } = input;
  const definition = checkDefinition(input.command);
  if (definition === null) return null;
  if (base === undefined) {
    return definition.kind === 'wrapper'
      ? `runs ${definition.runner}, and this run has no run base to compare its wrapper files with`
      : null;
  }
  if (definition.kind === 'script-file' && !isPathConfined(definition.file, workspaceDir)) {
    return `runs ${definition.file}, which is outside the run workspace`;
  }
  if (definition.kind === 'package-script' && !isPathConfined(definition.dir, workspaceDir)) {
    return `runs the package script ${definition.script} in ${definition.dir}, which is outside the run workspace`;
  }
  if (definition.kind === 'script-file' && isTestScript(definition.file)) return null;
  const read = await createRunBaseReader({ ...base, workspaceDir });
  if (definition.kind === 'script-file') {
    const atBase = await read(definition.file);
    if (atBase.kind === 'changed') return `runs ${definition.file}, which this run changed`;
    if (atBase.kind === 'new') return `runs ${definition.file}, which the run base does not hold`;
    return null;
  }
  if (definition.kind === 'task-file' || definition.kind === 'wrapper') {
    return taskFileRefusal(definition, read, workspaceDir);
  }
  for (const file of await manifestsOf(definition, base, workspaceDir)) {
    const refusal = await manifestRefusal(definition, file, read, workspaceDir);
    if (refusal !== null) return refusal;
  }
  return null;
}
