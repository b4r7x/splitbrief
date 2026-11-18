import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLI_HELP_FIXTURES } from '#testing/helpers/arg-vector-help.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import type { EffortLevel } from '../../../core/schemas/enums.js';
import { spawnWithTimeout } from '../../../lib/process/spawn/progress.js';
import { abortError } from '../../../utils/abort.js';
import { probeActivitySnapshot, subscribeProbeActivity } from '../../probe-activity.js';
import { collectArgVectorPreflightChecks } from './preflight.js';

vi.mock('../../../lib/process/spawn/progress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/process/spawn/progress.js')>();
  return { ...actual, spawnWithTimeout: vi.fn(actual.spawnWithTimeout) };
});

const tempDirs: string[] = [];
const fakePids: number[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const pid of fakePids.splice(0)) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  for (const directory of tempDirs.splice(0)) cleanupTempDir(directory);
});

function tempDir(prefix: string): string {
  const directory = createTempDir(prefix);
  tempDirs.push(directory);
  return directory;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function optionsProbeStarted(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const running = () => probeActivitySnapshot().probes.some((probe) => probe.check === 'options');
  const unsubscribe = subscribeProbeActivity(() => {
    if (!running()) return;
    unsubscribe();
    resolve();
  });
  return promise;
}

describe('collectArgVectorPreflightChecks — abort', () => {
  it('stops a hanging help read on abort and leaves no probe or process behind', {
    timeout: 10_000,
  }, async () => {
    const project = tempDir('preflight-abort-project');
    const toolDir = tempDir('preflight-abort-tools');
    const pidFile = join(toolDir, 'pids');
    writeFileSync(
      join(toolDir, 'codex'),
      ['#!/bin/sh', 'sleep 300 &', `echo "$$ $!" > ${JSON.stringify(pidFile)}`, 'wait', ''].join(
        '\n',
      ),
      'utf8',
    );
    chmodSync(join(toolDir, 'codex'), 0o755);
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);
    const controller = new AbortController();
    const started = optionsProbeStarted();

    const checks = collectArgVectorPreflightChecks({
      config: makeConfig({ planner: { kind: 'cli', tool: 'codex' } }),
      projectDir: project,
      roles: ['planner'],
      signal: controller.signal,
    });
    const settled = checks.then(
      () => 'resolved',
      () => 'rejected',
    );
    await started;
    const pids = await vi.waitFor(() => {
      const recorded = existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : '';
      expect(recorded).toMatch(/^\d+ \d+\n$/u);
      return recorded.trim().split(' ').map(Number);
    });
    fakePids.push(...pids);

    controller.abort();

    expect(await settled).toBe('rejected');
    expect(probeActivitySnapshot().probes).toEqual([]);
    await vi.waitFor(() => expect(pids.filter(isAlive)).toEqual([]), { timeout: 3_000 });
  });
});

describe('collectArgVectorPreflightChecks — default help invocation', () => {
  /** Records the environment it was handed, then answers like a real `--help`. */
  function writeCodexStub(path: string, envRecord: string): void {
    writeFileSync(
      path,
      [
        '#!/bin/sh',
        '{',
        `  printf 'HOME=%s\\n' "\${HOME-<unset>}"`,
        `  printf 'CANARY=%s\\n' "\${SPLITBRIEF_PREFLIGHT_CANARY-<unset>}"`,
        `} >> ${JSON.stringify(envRecord)}`,
        `printf 'Usage: codex exec [OPTIONS]\\n  --model <MODEL>  Model to use\\n'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(path, 0o755);
  }

  /** Answers `--help` and `<subcommand> --help` from a captured fixture, logging each call. */
  function writeHelpStub(
    path: string,
    log: string,
    fixtures: Readonly<Record<string, string>>,
  ): void {
    const branches = Object.entries(fixtures).map(
      ([argument, fixture]) =>
        `  ${argument}) cat ${JSON.stringify(join(CLI_HELP_FIXTURES, fixture))} ;;`,
    );
    writeFileSync(
      path,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
        'case "$1" in',
        ...branches,
        '  *) exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(path, 0o755);
  }

  function plannerChecks(
    projectDir: string,
    planner: Readonly<{ tool: CliToolId; model?: string; effort?: EffortLevel }> = {
      tool: 'codex',
    },
  ) {
    return collectArgVectorPreflightChecks({
      config: makeConfig({ planner: { kind: 'cli', ...planner } }),
      projectDir,
      roles: ['planner'],
    });
  }

  function helpInvocations(log: string): string[] {
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
  }
  it('never runs a project-local executable the trust ladder refuses, and reports ok', async () => {
    const project = tempDir('preflight-project');
    const binDir = join(project, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const envRecord = join(project, 'child-env');
    writeCodexStub(join(binDir, 'codex'), envRecord);
    vi.stubEnv('PATH', `${binDir}${delimiter}${process.env.PATH ?? ''}`);

    const checks = await plannerChecks(project);

    expect(existsSync(envRecord)).toBe(false);
    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.codex.arg-vector.planner',
        severity: 'ok',
        metadata: expect.objectContaining({ checked: 'unavailable' }),
      }),
    ]);
  });

  it('hands the trusted executable neither an ambient credential nor the real HOME', async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    const envRecord = join(toolDir, 'child-env');
    writeCodexStub(join(toolDir, 'codex'), envRecord);
    vi.stubEnv('HOME', '/home/real-user');
    vi.stubEnv('SPLITBRIEF_PREFLIGHT_CANARY', 'sk-canary-do-not-leak');
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);

    const checks = await plannerChecks(project);

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.codex.arg-vector.planner',
        severity: 'blocker',
        metadata: expect.objectContaining({ unsupported: expect.arrayContaining(['--json']) }),
      }),
    ]);
    const childEnv = readFileSync(envRecord, 'utf8');
    expect(childEnv).not.toContain('/home/real-user');
    expect(childEnv).not.toContain('sk-canary-do-not-leak');
  });

  it('gives every help read one minute', async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    writeHelpStub(join(toolDir, 'opencode'), join(toolDir, 'invocations'), {
      '--help': 'opencode-help.txt',
      run: 'opencode-run-help.txt',
    });
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);
    vi.mocked(spawnWithTimeout).mockClear();

    await plannerChecks(project, { tool: 'opencode' });

    const helpReads = vi
      .mocked(spawnWithTimeout)
      .mock.calls.filter(([options]) => options.args.includes('--help'));
    expect(helpReads.map(([options]) => options.args)).toEqual([['--help'], ['run', '--help']]);
    expect(helpReads.map(([options]) => options.timeout)).toEqual([60_000, 60_000]);
  });

  it('hands the preparation signal to every help read', async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    writeHelpStub(join(toolDir, 'opencode'), join(toolDir, 'invocations'), {
      '--help': 'opencode-help.txt',
      run: 'opencode-run-help.txt',
    });
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);
    vi.mocked(spawnWithTimeout).mockClear();
    const controller = new AbortController();

    await collectArgVectorPreflightChecks({
      config: makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }),
      projectDir: project,
      roles: ['planner'],
      signal: controller.signal,
    });

    const helpReads = vi
      .mocked(spawnWithTimeout)
      .mock.calls.filter(([options]) => options.args.includes('--help'));
    expect(helpReads).toHaveLength(2);
    // A help read gets the preparation signal joined with the process stop signal.
    controller.abort();
    for (const [options] of helpReads) expect(options.signal?.aborted).toBe(true);
  });

  it('rejects with the abort when the help read stops on the preparation signal', async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    writeCodexStub(join(toolDir, 'codex'), join(toolDir, 'child-env'));
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);
    const controller = new AbortController();
    const aborted = abortError(undefined);
    vi.mocked(spawnWithTimeout).mockImplementationOnce(async () => {
      controller.abort();
      throw aborted;
    });

    await expect(
      collectArgVectorPreflightChecks({
        config: makeConfig({ planner: { kind: 'cli', tool: 'codex' } }),
        projectDir: project,
        roles: ['planner'],
        signal: controller.signal,
      }),
    ).rejects.toBe(aborted);
  });

  it('descends into a yargs subcommand, whose help is the only one advertising --format', async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    const log = join(toolDir, 'invocations');
    writeHelpStub(join(toolDir, 'opencode'), log, {
      '--help': 'opencode-help.txt',
      run: 'opencode-run-help.txt',
    });
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);

    const topLevel = readFileSync(join(CLI_HELP_FIXTURES, 'opencode-help.txt'), 'utf8');
    expect(topLevel).toContain('opencode run [message..]');
    expect(topLevel).not.toContain('--format');

    const checks = await plannerChecks(project, { tool: 'opencode' });

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.opencode.arg-vector.planner',
        severity: 'ok',
        metadata: expect.objectContaining({ checked: 'help' }),
      }),
    ]);
    expect(helpInvocations(log)).toEqual(['--help', 'run --help']);
  });

  it('descends into an opencode 2 SUBCOMMANDS entry, whose help alone advertises the run flags', async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    const log = join(toolDir, 'invocations');
    writeHelpStub(join(toolDir, 'opencode'), log, {
      '--help': 'opencode-v2-help.txt',
      run: 'opencode-v2-run-help.txt',
    });
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);

    const topLevel = readFileSync(join(CLI_HELP_FIXTURES, 'opencode-v2-help.txt'), 'utf8');
    expect(topLevel).toContain('SUBCOMMANDS');
    expect(topLevel).not.toContain('--model');

    const checks = await plannerChecks(project, { tool: 'opencode' });

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.opencode.arg-vector.planner',
        severity: 'ok',
        metadata: expect.objectContaining({ checked: 'help' }),
      }),
    ]);
    expect(helpInvocations(log)).toEqual(['--help', 'run --help']);
  });

  // Command Code is the other tool whose emitted vector carries short flags — `-p` at index 0
  // and `-m` before the model — so widening the comparison to short flags put its whole
  // invocation at risk of a fabricated blocker. This is its real vector against its own help.
  it("accepts Command Code's short flags against the help the binary itself prints", async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    const log = join(toolDir, 'invocations');
    writeHelpStub(join(toolDir, 'cmd'), log, { '--help': 'command-code-help.txt' });
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);

    const checks = await plannerChecks(project, {
      tool: 'command-code',
      model: 'claude-opus-5',
      effort: 'high',
    });

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.command-code.arg-vector.planner',
        severity: 'ok',
        metadata: expect.objectContaining({ checked: 'help' }),
      }),
    ]);
    expect(helpInvocations(log)).toEqual(['--help']);
  });

  // With no HOME, `cmd` reads the user's own home through the account database. It then shows and
  // clears a pending "Updated X → Y" notice there, so the user never sees it in their next session.
  it('runs the help in a HOME of its own, never the user home', async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    const hostHome = tempDir('preflight-host-home');
    const envRecord = join(toolDir, 'child-home');
    writeFileSync(
      join(toolDir, 'cmd'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "\${HOME-<unset>}" >> ${JSON.stringify(envRecord)}`,
        `cat ${JSON.stringify(join(CLI_HELP_FIXTURES, 'command-code-help.txt'))}`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(join(toolDir, 'cmd'), 0o755);
    vi.stubEnv('HOME', hostHome);
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);

    await plannerChecks(project, { tool: 'command-code', model: 'claude-opus-5' });

    const childHome = readFileSync(envRecord, 'utf8').trim();
    expect(childHome).not.toBe('<unset>');
    expect(childHome).not.toBe(hostHome);
    expect(childHome).not.toBe('');
  });

  // The seat carries an effort so the recorded help — where `-c, --config <key=value>` stands
  // alone on its entry line and the description follows indented — is what the short-flag
  // comparison is pinned against, not only the hand-written CODEX_HELP above.
  it('probes the plan, one-shot and resume argv against one fetch of each clap help', async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    const log = join(toolDir, 'invocations');
    writeHelpStub(join(toolDir, 'codex'), log, {
      '--help': 'codex-help.txt',
      exec: 'codex-exec-help.txt',
    });
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);

    const checks = await plannerChecks(project, { tool: 'codex', effort: 'high' });

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.codex.arg-vector.planner',
        severity: 'ok',
        metadata: expect.objectContaining({ checked: 'help' }),
      }),
    ]);
    expect(checks[0]?.details).toBeUndefined();
    expect(helpInvocations(log)).toEqual(['--help', 'exec --help']);
  });
});
