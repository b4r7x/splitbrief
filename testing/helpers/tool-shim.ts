import { join } from 'node:path';
import type { CliExecutableIdentity } from '../../src/core/discovery/detection/executable.js';
import { CLI_TOOL_CATALOG } from '../../src/core/runners/cli-tool/catalog.js';
import { resolveCliExecutable } from '../../src/engine/runners/cli-executable/resolve.js';
import { makeExecutable } from './cli-executable.js';

/** Writes `script` as the executable `name` in `directory` and resolves it as a probe resolves its tool. */
export async function installToolShim(
  directory: string,
  name: string,
  script: string,
): Promise<CliExecutableIdentity> {
  const path = join(directory, name);
  makeExecutable(path, script);
  return resolveCliExecutable({ command: path, projectDir: '/neutral/project' });
}

/** The `--version` answer of a `codex` at its tested release. */
export const CODEX_VERSION_LINES = [
  `printf '%s\\n' 'codex-cli ${CLI_TOOL_CATALOG.codex.compatibility.testedVersion}'`,
  'exit 0',
] as const;

/**
 * A `codex` that logs each argv and answers `login status` like the tool: signed in when its
 * staged HOME holds the sign-in file or its environment holds `OPENAI_API_KEY`. Like the tool, it
 * keeps its own state beside the sign-in file, under `$HOME/.codex`.
 */
export function signInCodexShim(
  input: Readonly<{ argvLog: string; versionLines: readonly string[] }>,
): string {
  return [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(input.argvLog)}`,
    'mkdir -p "$HOME/.codex/log" && printf "%s\\n" "$*" >> "$HOME/.codex/log/codex.log"',
    'if [ "$1" = "--version" ]; then',
    ...input.versionLines.map((line) => `  ${line}`),
    'fi',
    'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
    '  if [ -n "$OPENAI_API_KEY" ] || [ -f "$HOME/.codex/auth.json" ]; then',
    "    printf '%s\\n' 'Logged in'",
    '    exit 0',
    '  fi',
    "  printf '%s\\n' 'Not logged in' >&2",
    '  exit 1',
    'fi',
    'if [ "$1" = "debug" ] && [ "$2" = "models" ] && [ -z "$3" ]; then',
    `  printf '%s\\n' ${JSON.stringify(JSON.stringify({ models: [{ id: 'model-a' }] }))}`,
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n');
}
