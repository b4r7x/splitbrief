import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../../../utils/type-guards.js';
import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import { createRunBaseReader } from '../isolation/acquisition.js';
import type { RunBase } from '../isolation/base-tree.js';

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const SCRIPT_SUBCOMMANDS = new Set(['run', 'run-script']);
const TEST_SUBCOMMANDS = new Set(['test', 't']);
/** pnpm and yarn run a script named by their first argument when it is not a built-in command. */
const BARE_SCRIPT_RUNNERS = new Set(['pnpm', 'yarn']);
const TASK_FILES: Readonly<Record<string, readonly string[]>> = {
  make: ['Makefile', 'makefile', 'GNUmakefile'],
  just: ['justfile', 'Justfile', '.justfile'],
};

type Definition =
  | { kind: 'package-script'; runner: string; script: string }
  | { kind: 'task-file'; runner: string; files: readonly string[] };

function packageScriptOf(cmd: string, args: readonly string[]): Definition | null {
  const [sub, name] = args.filter((arg) => !arg.startsWith('-'));
  if (sub === undefined) return null;
  // `bun test` is bun's own test runner; only `bun run test` runs the script.
  if (TEST_SUBCOMMANDS.has(sub)) {
    return cmd === 'bun' ? null : { kind: 'package-script', runner: cmd, script: 'test' };
  }
  if (SCRIPT_SUBCOMMANDS.has(sub)) {
    return name === undefined ? null : { kind: 'package-script', runner: cmd, script: name };
  }
  return BARE_SCRIPT_RUNNERS.has(cmd) ? { kind: 'package-script', runner: cmd, script: sub } : null;
}

/** npm runs `pre<script>` and `post<script>` around a script, so they are part of what it runs. */
function scriptsRun(definition: { runner: string; script: string }): string[] {
  const { runner, script } = definition;
  return runner === 'npm' ? [`pre${script}`, script, `post${script}`] : [script];
}

/** The project file that defines what a command runs, when the command runs a script or a task. */
function commandDefinition(command: string): Definition | null {
  const [cmd, ...args] = parseShellCommand(command);
  if (cmd === undefined) return null;
  if (PACKAGE_MANAGERS.has(cmd)) return packageScriptOf(cmd, args);
  const files = TASK_FILES[cmd];
  return files === undefined ? null : { kind: 'task-file', runner: cmd, files };
}

function packageScripts(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && isRecord(parsed['scripts']) ? parsed['scripts'] : {};
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

/**
 * A command whose script or task file this run changed runs code the run wrote, not the project's
 * own check, so it is refused. Null when the definition is the one the run started from.
 */
export async function changedDefinitionRefusal(input: {
  command: string;
  base: RunBase;
  workspaceDir: string;
}): Promise<string | null> {
  const definition = commandDefinition(input.command);
  if (definition === null) return null;
  const read = await createRunBaseReader({ ...input.base, workspaceDir: input.workspaceDir });
  if (definition.kind === 'task-file') {
    for (const file of definition.files) {
      const atBase = await read(file);
      if (atBase.kind === 'changed') {
        return `runs ${definition.runner} on ${file}, which this run changed`;
      }
    }
    return null;
  }
  const atBase = await read('package.json');
  if (atBase.kind !== 'changed') return null;
  const before = packageScripts(atBase.text);
  const after = packageScripts(await workspaceText(input.workspaceDir, 'package.json'));
  if (before === null || after === null) {
    return `runs the package script ${definition.script}, and this run changed package.json`;
  }
  const changed = scriptsRun(definition).find((script) => before[script] !== after[script]);
  if (changed === undefined) return null;
  return changed === definition.script
    ? `runs the package script ${changed}, which this run changed`
    : `runs the package script ${definition.script} with its ${changed} script, which this run changed`;
}
