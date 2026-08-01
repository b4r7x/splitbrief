import { chmodSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliToolId } from '../../src/core/runners/cli-tool-catalog.js';
import type { CliStartGate } from '../../src/engine/runners/start-gate.js';

export interface CommandShimOptions {
  dir: string;
  command: string;
  /** Lines printed to stdout via printf, single-quote escaped. */
  lines: string[];
  /** Seconds slept before printing — idle-watchdog tests use ~0.15. */
  sleepSeconds?: number;
}

export function writeCommandShim(opts: CommandShimOptions): string {
  const printfLines = opts.lines.map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`);
  const script = [
    '#!/bin/bash',
    ...(opts.sleepSeconds === undefined ? [] : [`sleep ${opts.sleepSeconds}`]),
    ...printfLines,
    '',
  ].join('\n');
  const shimPath = join(opts.dir, opts.command);
  writeFileSync(shimPath, script, 'utf8');
  chmodSync(shimPath, 0o755);
  return shimPath;
}

export function prependPath(dir: string): () => void {
  const original = process.env['PATH'];
  process.env['PATH'] = `${dir}:${original ?? ''}`;
  return () => {
    if (original === undefined) delete process.env['PATH'];
    else process.env['PATH'] = original;
  };
}

export function trustedCliGateFor(
  tool: CliToolId,
  shimDir: string,
  command: string = tool,
): CliStartGate {
  const commandPath = join(shimDir, command);
  const path = realpathSync(commandPath);
  const info = statSync(path);
  return {
    tool,
    executable: {
      path,
      fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
    },
  };
}

export type ContractShimTransport = 'stdin' | 'argv';

export type ContractShimMode =
  | 'success-direct'
  | 'no-op'
  | 'outside-write'
  | 'provider-state-write'
  | 'non-zero-exit'
  | 'protocol-failure'
  | 'partial-protocol'
  | 'timeout'
  | 'abort-wait'
  | 'signal-exit'
  | 'output-flood';

export interface ContractShimProfile {
  transport: ContractShimTransport;
  versionLine: string;
  successLines: readonly string[];
  authArgv: readonly string[];
}

export interface ContractShimOptions {
  dir: string;
  command: string;
  profile: ContractShimProfile;
  mode: ContractShimMode;
  projectDir: string;
  targetRelPath?: string;
  captureDir?: string;
  exitCode?: number;
  versionExitCode?: number;
  authExitCode?: number;
  sleepMs?: number;
  outsidePath?: string;
  providerStateRelPath?: string;
  versionLine?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function writeContractShim(opts: ContractShimOptions): string {
  const versionLine = opts.versionLine ?? opts.profile.versionLine;
  const captureDir = opts.captureDir ?? '';
  const targetRelPath = opts.targetRelPath ?? 'src/contract.ts';
  const providerStateRelPath = opts.providerStateRelPath ?? '.splitbrief/provider-state.json';
  const exitCode = opts.exitCode ?? 17;
  const versionExitCode = opts.versionExitCode ?? 0;
  const authExitCode = opts.authExitCode ?? 0;
  const successLines = opts.profile.successLines
    .map((line) => `printf '%s\\n' ${shellQuote(line)}`)
    .join('\n');
  const outsideWrite =
    opts.outsidePath === undefined
      ? ''
      : `mkdir -p "$(dirname ${shellQuote(opts.outsidePath)})"\nprintf 'outside\\n' > ${shellQuote(opts.outsidePath)}`;
  const authMatch = opts.profile.authArgv
    .map((part, index) => `[ "\${${index + 1}:-}" = ${shellQuote(part)} ]`)
    .join(' && ');
  const authArgCount = opts.profile.authArgv.length;

  const script = [
    '#!/bin/bash',
    'set -euo pipefail',
    `PROJECT_DIR=${shellQuote(opts.projectDir)}`,
    `CAPTURE_DIR=${shellQuote(captureDir)}`,
    `TARGET_REL=${shellQuote(targetRelPath)}`,
    `PROVIDER_STATE_REL=${shellQuote(providerStateRelPath)}`,
    `MODE=${shellQuote(opts.mode)}`,
    `TRANSPORT=${shellQuote(opts.profile.transport)}`,
    `VERSION_LINE=${shellQuote(versionLine)}`,
    'auth_matches() {',
    `  ${authMatch}`,
    '}',
    'if [[ " $* " == *" --version "* ]]; then',
    `  printf '%s\\n' "$VERSION_LINE"`,
    `  exit ${versionExitCode}`,
    'fi',
    `if [[ $# -ge ${authArgCount} ]] && auth_matches "$@"; then`,
    `  exit ${authExitCode}`,
    'fi',
    'if [[ -n "$CAPTURE_DIR" ]]; then',
    '  mkdir -p "$CAPTURE_DIR"',
    '  printf \'%s\\n\' "$@" > "$CAPTURE_DIR/argv.lines"',
    'fi',
    'if [[ "$TRANSPORT" == "stdin" ]]; then',
    '  STDIN_TEXT="$(cat)"',
    '  if [[ -n "$CAPTURE_DIR" ]]; then printf \'%s\' "$STDIN_TEXT" > "$CAPTURE_DIR/stdin.txt"; fi',
    'fi',
    'write_direct() {',
    '  mkdir -p "$(dirname "$PROJECT_DIR/$TARGET_REL")"',
    '  printf \'generated\\n\' > "$PROJECT_DIR/$TARGET_REL"',
    '}',
    'write_provider_state() {',
    '  mkdir -p "$(dirname "$PROJECT_DIR/$PROVIDER_STATE_REL")"',
    '  printf \'{}\\n\' > "$PROJECT_DIR/$PROVIDER_STATE_REL"',
    '}',
    'case "$MODE" in',
    '  success-direct)',
    '    write_direct',
    successLines,
    '    exit 0',
    '    ;;',
    '  no-op)',
    successLines,
    '    exit 0',
    '    ;;',
    '  outside-write)',
    outsideWrite || 'true',
    successLines,
    '    exit 0',
    '    ;;',
    '  provider-state-write)',
    '    write_provider_state',
    successLines,
    '    exit 0',
    '    ;;',
    '  non-zero-exit)',
    "    printf 'fixture stderr\\n' >&2",
    `    exit ${exitCode}`,
    '    ;;',
    '  protocol-failure)',
    "    printf 'not-a-protocol-line\\n'",
    '    exit 0',
    '    ;;',
    '  partial-protocol)',
    successLines.split('\n')[0] ?? 'true',
    "    printf 'not-a-protocol-line\\n'",
    '    exit 0',
    '    ;;',
    '  timeout)',
    '    while true; do sleep 1; done',
    '    ;;',
    '  abort-wait)',
    '    if [[ -n "$CAPTURE_DIR" ]]; then printf yes > "$CAPTURE_DIR/started.marker"; fi',
    '    ( while true; do sleep 1; done ) &',
    '    DESCENDANT_PID=$!',
    '    if [[ -n "$CAPTURE_DIR" ]]; then printf \'%s\' "$DESCENDANT_PID" > "$CAPTURE_DIR/descendant.pid"; fi',
    '    while true; do sleep 1; done',
    '    ;;',
    '  signal-exit)',
    '    kill -TERM "$$"',
    '    ;;',
    '  output-flood)',
    '    dd if=/dev/zero bs=1024 count=1025 2>/dev/null | tr "\\000" "x"',
    '    exit 0',
    '    ;;',
    '  *)',
    '    exit 1',
    '    ;;',
    'esac',
    '',
  ].join('\n');

  const shimPath = join(opts.dir, opts.command);
  writeFileSync(shimPath, script, 'utf8');
  chmodSync(shimPath, 0o755);
  return shimPath;
}

export function writeConflictProbeShim(opts: {
  dir: string;
  command: string;
  markerPath: string;
}): string {
  const script = ['#!/bin/bash', `touch ${shellQuote(opts.markerPath)}`, 'exit 0', ''].join('\n');
  const shimPath = join(opts.dir, opts.command);
  writeFileSync(shimPath, script, 'utf8');
  chmodSync(shimPath, 0o755);
  return shimPath;
}
