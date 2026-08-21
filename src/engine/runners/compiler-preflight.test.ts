import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  capabilityTuple,
  conformanceProof,
  unverifiedConformanceProof,
} from '#testing/helpers/factories/compiler-capability.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { admitCompilerCapability } from './compiler-capability.js';
import { collectArgVectorPreflightChecks } from './arg-vector-preflight.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of tempDirs.splice(0)) cleanupTempDir(directory);
});

function tempDir(prefix: string): string {
  const directory = createTempDir(prefix);
  tempDirs.push(directory);
  return directory;
}

/**
 * Writes a fixture binary that logs every invocation argv to `log` and answers
 * `--help` / `<subcommand> --help` from `helpTexts`.
 */
function writeHelpFixture(
  path: string,
  log: string,
  helpTexts: Readonly<Record<string, string>>,
): void {
  const branches = Object.entries(helpTexts).map(
    ([argv, text]) => `  ${argv}) cat <<'SPLITBRIEF_FIXTURE'\n${text}SPLITBRIEF_FIXTURE\n  ;;`,
  );
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'case "$*" in',
      ...branches,
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(path, 0o755);
}

function stubToolsPath(toolsDir: string): void {
  vi.stubEnv('PATH', `${toolsDir}${delimiter}${process.env.PATH ?? ''}`);
}

const OPENCODE_TOP_LEVEL_HELP = [
  'Usage: opencode [command] [options]',
  '',
  'Commands:',
  '  run  Run opencode with a message',
  '',
  'Options:',
  '  --format <format>    Output format',
  '',
].join('\n');

const OPENCODE_RUN_HELP = [
  'Usage: opencode run [message..]',
  '',
  'Options:',
  '  --format <format>    Output format',
  '  --agent <agent>      Agent to use',
  '',
].join('\n');

describe('compiler preflight — fake help, cwd writes, and zero-spawn refusal', () => {
  it('a help text that advertises every flag never admits compiler capability, and dispatches nothing', async () => {
    const project = tempDir('compiler-preflight-fake-help');
    const toolsDir = tempDir('compiler-preflight-tools');
    const log = join(toolsDir, 'invocations');
    const dispatchMarker = join(toolsDir, 'dispatched');
    writeFileSync(
      join(toolsDir, 'opencode'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
        `case "$*" in`,
        `  '--help') cat <<'SPLITBRIEF_FIXTURE'\n${OPENCODE_TOP_LEVEL_HELP}SPLITBRIEF_FIXTURE\n  ;;`,
        `  'run --help') cat <<'SPLITBRIEF_FIXTURE'\n${OPENCODE_RUN_HELP}SPLITBRIEF_FIXTURE\n  ;;`,
        `  *) touch ${JSON.stringify(dispatchMarker)} ;;`,
        'esac',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(join(toolsDir, 'opencode'), 0o755);
    stubToolsPath(toolsDir);

    const checks = await collectArgVectorPreflightChecks({
      config: makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }),
      projectDir: project,
      includeImplementers: false,
    });
    expect(checks[0]).toMatchObject({
      id: 'runners.cli.opencode.arg-vector.planner',
      severity: 'ok',
      metadata: expect.objectContaining({ checked: 'help' }),
    });

    const admission = admitCompilerCapability(
      capabilityTuple('opencode', { conformance: unverifiedConformanceProof() }),
    );
    expect(admission.kind).toBe('refused');

    expect(readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)).toEqual([
      '--help',
      'run --help',
    ]);
    expect(existsSync(dispatchMarker)).toBe(false);
  });

  it('runs the staged help probe with a sealed disposable cwd, never the project', async () => {
    const project = tempDir('compiler-preflight-cwd');
    const toolsDir = tempDir('compiler-preflight-cwd-tools');
    const log = join(toolsDir, 'seal-log');
    writeFileSync(
      join(toolsDir, 'opencode'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
        'if echo marker > ./cwd-marker.txt 2>/dev/null; then',
        `  printf 'CWD_WRITABLE\\n' >> ${JSON.stringify(log)}`,
        'else',
        `  printf 'CWD_SEALED\\n' >> ${JSON.stringify(log)}`,
        'fi',
        `case "$*" in`,
        `  '--help') cat <<'SPLITBRIEF_FIXTURE'\n${OPENCODE_TOP_LEVEL_HELP}SPLITBRIEF_FIXTURE\n  ;;`,
        `  'run --help') cat <<'SPLITBRIEF_FIXTURE'\n${OPENCODE_RUN_HELP}SPLITBRIEF_FIXTURE\n  ;;`,
        '  *) exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(join(toolsDir, 'opencode'), 0o755);
    stubToolsPath(toolsDir);

    const checks = await collectArgVectorPreflightChecks({
      config: makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }),
      projectDir: project,
      includeImplementers: false,
    });
    expect(checks[0]?.severity).toBe('ok');

    const logText = readFileSync(log, 'utf8');
    expect(logText).toContain('CWD_SEALED');
    expect(existsSync(join(project, 'cwd-marker.txt'))).toBe(false);
  });

  it('a semantic override refusal spawns zero processes', async () => {
    const project = tempDir('compiler-preflight-zero-spawn');
    const toolsDir = tempDir('compiler-preflight-zero-tools');
    const log = join(toolsDir, 'invocations');
    writeHelpFixture(join(toolsDir, 'claude'), log, {
      '--help': 'Usage: claude [options] [command]\n  -p, --print\n',
    });
    stubToolsPath(toolsDir);

    const checks = await collectArgVectorPreflightChecks({
      config: makeConfig({
        planner: {
          kind: 'cli',
          tool: 'claude-code',
          args: ['--add-dir', '/srv/shared-context'],
        },
      }),
      projectDir: project,
      includeImplementers: false,
    });
    expect(checks[0]).toMatchObject({
      id: 'runners.cli.claude-code.arg-vector.planner',
      severity: 'blocker',
      metadata: expect.objectContaining({ semantic: ['--add-dir'] }),
    });
    expect(existsSync(log)).toBe(false);
  });

  it('an unverified conformance proof refuses a compiler dispatch that claims every flag', async () => {
    const toolsDir = tempDir('compiler-preflight-dispatch');
    const dispatchMarker = join(toolsDir, 'dispatched');
    writeFileSync(
      join(toolsDir, 'opencode'),
      [
        '#!/bin/sh',
        `touch ${JSON.stringify(dispatchMarker)}`,
        "printf 'Usage: opencode run [message..]\\n  --format <format>\\n  --agent <agent>\\n'",
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(join(toolsDir, 'opencode'), 0o755);
    stubToolsPath(toolsDir);

    const admission = admitCompilerCapability(
      capabilityTuple('opencode', {
        conformance: conformanceProof({ credentialIsolation: 'unverified' }),
      }),
    );
    expect(admission.kind).toBe('refused');
    if (admission.kind === 'refused') expect(admission.missing).toContain('conformance');
    expect(existsSync(dispatchMarker)).toBe(false);
  });
});
