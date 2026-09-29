import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliImplementerConfig } from '../../core/schemas/implementer-config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { prependPath, trustedShimGate } from '#testing/helpers/command-shim.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createCliImplementer } from './cli.js';

const OPENCODE_STREAM = join(
  import.meta.dirname,
  '../../../testing/fixtures/opencode/stream-json.ndjson',
);
// The boundary leaves the temp directories open to every tool, so the skill lives outside them.
const ARTIFACTS = join(import.meta.dirname, '../../../.test-artifacts');

const opencode: CliImplementerConfig = {
  kind: 'cli',
  tool: 'opencode',
  authChannel: 'provider-dependent',
  model: 'opencode/test-isolation',
  contextLength: 4096,
};

let dirs: string[] = [];
let restorePath: () => void;
let checkoutDir: string;
let isolationDir: string;
let home: string;
let skillDir: string;
let shimDir: string;

beforeEach(() => {
  checkoutDir = createTempDir('skill-roots-checkout');
  isolationDir = createTempDir('skill-roots-isolation');
  mkdirSync(ARTIFACTS, { recursive: true });
  home = mkdtempSync(join(ARTIFACTS, 'skill-roots-home-'));
  shimDir = createTempDir('skill-roots-shim');
  dirs = [checkoutDir, isolationDir, shimDir];
  createTestGitRepo(checkoutDir);
  createTestGitRepo(isolationDir);
  skillDir = join(home, '.claude', 'skills', 'auth');
  mkdirSync(join(skillDir, 'references'), { recursive: true });
  writeFileSync(join(skillDir, 'references', 'api.md'), '# api\n');
  restorePath = prependPath(shimDir);
});

afterEach(() => {
  restorePath();
  for (const dir of dirs) cleanupTempDir(dir);
  rmSync(home, { recursive: true, force: true });
});

/** An opencode build that announces one shell call, then writes the brief's file and completes. */
function installShim(command: string): ReturnType<typeof trustedShimGate> {
  const toolUse = JSON.stringify({
    type: 'tool_use',
    sessionID: 'ses_skill_roots',
    part: {
      type: 'tool',
      callID: 'call_1',
      tool: 'bash',
      state: { status: 'running', input: { command } },
    },
  });
  writeFileSync(
    join(shimDir, 'opencode'),
    [
      '#!/bin/bash',
      'if [[ " $* " == *" --version "* ]]; then echo "opencode 1.18.15"; exit 0; fi',
      `printf '%s\\n' '${toolUse}'`,
      'mkdir -p src',
      `printf '%s' 'export const greet = 1;' > "$PWD/src/greet.ts"`,
      `cat '${OPENCODE_STREAM}'`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return trustedShimGate({ dir: shimDir, tool: 'opencode' });
}

async function implement(command: string, skillRoots?: readonly string[]) {
  const implementer = createCliImplementer(opencode, { trustedCli: installShim(command) });
  return implementer.implement({
    task: makeTask({ id: 'T001', action: 'create', file: 'src/greet.ts' }),
    projectDir: isolationDir,
    fileIgnoreProjectDir: checkoutDir,
    config: makeConfig({ implementer: opencode }),
    context: {
      name: 'demo',
      dir: checkoutDir,
      ...(skillRoots !== undefined && { skillRoots }),
    },
    onOutput: () => {},
  });
}

describe("createCliImplementer — the run's attached skills", { timeout: 30_000 }, () => {
  it('lets the implementer read a listed reference of an attached skill', async () => {
    const result = await implement(`cat ${join(skillDir, 'references', 'api.md')}`, [skillDir]);

    expect(result).toMatchObject({ success: true });
  });

  it('halts the same read when no skill is attached', async () => {
    const result = await implement(`cat ${join(skillDir, 'references', 'api.md')}`);

    expect(result).toMatchObject({ success: false, outcome: 'implementer-left-isolation' });
  });

  it('hands a Claude Code implementer the attached skills as read-only directories', async () => {
    const argvFile = join(shimDir, 'argv.txt');
    writeFileSync(
      join(shimDir, 'claude'),
      [
        '#!/bin/bash',
        `printf '%s\\n' "$@" > '${argvFile}'`,
        'cat > /dev/null',
        'mkdir -p src',
        `printf '%s' 'export const greet = 1;' > "$PWD/src/greet.ts"`,
        `printf '%s\\n' '{"type":"result","result":"done"}'`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const claude: CliImplementerConfig = { kind: 'cli', tool: 'claude-code', contextLength: 4096 };
    const implementer = createCliImplementer(claude, {
      trustedCli: trustedShimGate({ dir: shimDir, tool: 'claude-code' }),
    });

    const result = await implementer.implement({
      task: makeTask({ id: 'T001', action: 'create', file: 'src/greet.ts' }),
      projectDir: isolationDir,
      fileIgnoreProjectDir: checkoutDir,
      config: makeConfig({ implementer: claude }),
      context: { name: 'demo', dir: checkoutDir, skillRoots: [skillDir] },
      onOutput: () => {},
    });

    expect(result).toMatchObject({ success: true });
    const argv = readFileSync(argvFile, 'utf8').split('\n');
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '');
    expect(settings.permissions.additionalDirectories).toEqual([skillDir]);
    expect(settings.sandbox.filesystem.denyWrite).toEqual([skillDir]);
  });

  it('halts a write into an attached skill', async () => {
    const result = await implement(`printf x > ${join(skillDir, 'references', 'api.md')}`, [
      skillDir,
    ]);

    expect(result).toMatchObject({ success: false, outcome: 'implementer-left-isolation' });
  });
});
