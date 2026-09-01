import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  getStartCommandTmp,
  readSingleSessionArtifact,
  runStart,
  setupStartCommandIntegration,
  spawnServerMock,
  writeReadyReadinessFixtures,
} from '#testing/helpers/start-command.js';
import {
  CONFIG_FILE,
  sessionDir,
  SPLITBRIEF_DIR,
  TREES_DIR,
  worktreePath,
} from '../../../src/core/paths.js';
import { isCliError } from '../../../src/cli/errors.js';
import { isOpaqueSessionId } from '../../../src/core/sessions/session-id.js';
import type { SpawnServerResult } from '../../../src/engine/ipc/detached-handshake.js';
import type { SpawnServerOptions } from '../../../src/engine/ipc/server-invocation.js';
import { parseIpcServerArgs, type IpcServerArgs } from '../../../src/engine/ipc/server-args.js';
import { formatDetachedAttachHint } from '../../../src/cli/commands/attach-hint.js';

setupStartCommandIntegration();

const itUnix = process.platform === 'win32' ? it.skip : it;

function captureConsoleLog(): string[] {
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  });
  return output;
}

function readServerArgsArtifact(projectDir: string): IpcServerArgs {
  const artifact = parseIpcServerArgs(readSingleSessionArtifact(projectDir, 'server-args.json'));
  if (artifact === null) throw new Error('Expected a valid detached server bootstrap artifact');
  return artifact;
}

/** Points the implementer at a custom endpoint whose credential can only be inline. */
function writeCustomEndpointImplementer(projectDir: string): void {
  const configFilePath = join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE);
  writeFileSync(
    configFilePath,
    readFileSync(configFilePath, 'utf-8').replace(
      '  provider: ollama\n  apiBase: http://localhost:11434/v1\n',
      [
        '  provider: custom-endpoint',
        '  service: custom-endpoint',
        '  offering: payg',
        '  apiBase: https://api.example.test/v1',
        '  apiKey: test-key',
        '',
      ].join('\n'),
    ),
  );
}

describe('start command — detached', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PLANNER_KEY;
  });

  it('applies --worktree before --detach creates detached session artifacts', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    const wtPath = worktreePath(tmp, 'detached-feature');
    const output = captureConsoleLog();

    await runStart(['--project', tmp, '--worktree', 'detached-feature', '--detach', 'implement X']);

    const artifact = readServerArgsArtifact(wtPath);
    expect(artifact.projectDir).toBe(wtPath);
    expect(artifact.candidate.sessionId).toBeDefined();
    expect(artifact).not.toHaveProperty('configPath');
    expect(existsSync(join(wtPath, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(true);

    const outputText = output.join('\n');
    expect(outputText).toContain('splitbrief attach');
    expect(outputText).toContain('--project');
    expect(outputText).not.toContain('cd ');
  });

  it('prints a shell-safe attach hint with --project for paths containing spaces', async () => {
    const tmp = getStartCommandTmp();
    const spaced = join(tmp, 'my project');
    mkdirSync(spaced, { recursive: true });
    createTestGitRepo(spaced);
    writeReadyReadinessFixtures(spaced);
    const output = captureConsoleLog();

    await runStart(['--project', spaced, '--detach', 'implement X']);

    const sessionIds = readdirSync(join(spaced, SPLITBRIEF_DIR, 'sessions'));
    expect(sessionIds).toHaveLength(1);
    const sessionId = sessionIds[0] ?? '';

    const expectedRun = `Run: ${formatDetachedAttachHint(spaced, sessionId)}`;
    const outputText = output.join('\n');
    expect(outputText).toContain(expectedRun);
    expect(outputText).not.toContain('cd ');
  });

  it('preserves config workflow mode when --detach omits --mode', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    const configFilePath = join(tmp, SPLITBRIEF_DIR, CONFIG_FILE);
    writeFileSync(
      configFilePath,
      readFileSync(configFilePath, 'utf-8').replace('mode: standard', 'mode: quick'),
    );
    captureConsoleLog();

    await runStart(['--project', tmp, '--detach', 'implement X']);

    const artifact = readServerArgsArtifact(tmp);
    expect(artifact.overrides.mode).toBe('quick');
    expect(artifact).not.toHaveProperty('mode');
  });

  it('forwards transport-safe detached CLI overrides in the private bootstrap artifact', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    writeCustomEndpointImplementer(tmp);
    process.env.PLANNER_KEY = 'test-planner-key';
    captureConsoleLog();

    await runStart([
      '--project',
      tmp,
      '--detach',
      '--planner',
      'codex',
      '--planner-model',
      'gpt-5',
      '--planner-command',
      'plan-it',
      '--planner-api-base',
      'https://planner.example/v1',
      '--planner-output-format',
      'stream-json',
      '--planner-context-length',
      '200000',
      '--implementer',
      'custom-endpoint',
      '--implementer-model',
      'qwen/qwen3-coder',
      '--implementer-command',
      'build-it',
      '--implementer-api-base',
      'https://api.example.test/v1',
      '--implementer-output-format',
      'opencode',
      '--implementer-context-length',
      '131072',
      '--model',
      'alias-model',
      '--provider',
      'lm-studio',
      '--approve',
      'all',
      '--budget',
      '4.25',
      '--planner-effort',
      'high',
      '--mode',
      'quick',
      'implement X',
    ]);

    const artifact = readServerArgsArtifact(tmp);
    expect(artifact).toMatchObject({
      version: 1,
      projectDir: tmp,
      feature: 'implement X',
      candidate: {
        version: 1,
        sessionId: expect.any(String),
        generation: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
      },
      overrides: {
        planner: {
          tool: 'codex',
          model: 'gpt-5',
          command: 'plan-it',
          apiBase: 'https://planner.example/v1',
          outputFormat: 'stream-json',
          contextLength: 200_000,
        },
        implementer: {
          tool: 'custom-endpoint',
          model: 'qwen/qwen3-coder',
          command: 'build-it',
          apiBase: 'https://api.example.test/v1',
          outputFormat: 'opencode',
          contextLength: 131_072,
        },
        approve: 'all',
        mode: 'quick',
        budget: 4.25,
        plannerEffort: 'high',
      },
    });
    expect(artifact.overrides.planner).not.toHaveProperty('apiKey');
    expect(artifact.overrides.implementer).not.toHaveProperty('apiKey');
    expect(JSON.stringify(artifact)).not.toContain('test-key');
    expect(JSON.stringify(artifact)).not.toContain('test-planner-key');
    expect(artifact).not.toHaveProperty('configPath');
    expect(artifact).not.toHaveProperty('gates');
  });

  it.each([
    ['--planner-args', '--secret-header'],
    ['--implementer-args', '--secret-header'],
    ['--planner-api-key-env', 'PLANNER_KEY'],
    ['--implementer-api-key-env', 'IMPLEMENTER_KEY'],
  ])('rejects detached %s before allocating a session', async (flag, value) => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    captureConsoleLog();

    await expect(
      runStart(['--project', tmp, '--detach', flag, value, 'implement X']),
    ).rejects.toThrow(/cannot cross the process boundary safely/);

    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'sessions'))).toBe(false);
  });

  itUnix(
    'prints config load warnings to stderr on the detached path before spawning the server',
    async () => {
      const tmp = getStartCommandTmp();
      writeReadyReadinessFixtures(tmp);
      const configFilePath = join(tmp, SPLITBRIEF_DIR, CONFIG_FILE);
      writeFileSync(
        configFilePath,
        [
          'version: 3',
          'planner:',
          '  kind: shell',
          "  command: 'true'",
          '  outputFormat: text',
          '  model: shell',
          '  contextLength: 32768',
          'implementer:',
          '  kind: api',
          '  provider: ollama',
          '  apiBase: http://localhost:11434/v1',
          '  model: qwen2.5-coder:7b',
          '  contextLength: 32768',
          'validation:',
          '  typecheck: true',
          '  lint: true',
          '  test: true',
          '  typecheckCommand: node -e ""',
          '  lintCommand: node -e ""',
          '  testCommand: node -e ""',
          'workflow:',
          '  approve: default',
          '  maxRetries: 3',
          '  persistTranscript: true',
          '  mode: standard',
        ].join('\n'),
      );
      chmodSync(configFilePath, 0o666);
      captureConsoleLog();
      const stderrChunks: string[] = [];
      let warningsBeforeSpawn = '';
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderrChunks.push(String(chunk));
        return true;
      });
      spawnServerMock.mockImplementationOnce(async (opts: SpawnServerOptions) => {
        warningsBeforeSpawn = stderrChunks.join('');
        mkdirSync(sessionDir(opts.projectDir, opts.candidate.sessionId), { recursive: true });
        return { ok: true, pid: 1234, sessionId: opts.candidate.sessionId };
      });

      await runStart(['--project', tmp, '--detach', 'implement X']);

      expect(warningsBeforeSpawn).toContain('has overly permissive permissions');
    },
  );

  it.each(['full', 'spec-kit'])('rejects the removed --mode %s alias', async (mode) => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    captureConsoleLog();

    await expect(
      runStart(['--project', tmp, '--detach', '--mode', mode, 'implement X']),
    ).rejects.toThrow(/Invalid mode: (full|spec-kit)\. Must be one of: quick, standard, speckit/);
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'sessions'))).toBe(false);
  });

  it('accepts the retired instant name and starts in quick', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    captureConsoleLog();

    await runStart(['--project', tmp, '--detach', '--mode', 'instant', 'implement X']);

    expect(readServerArgsArtifact(tmp).overrides.mode).toBe('quick');
  });

  it('clears the active pointer when detached server spawn fails', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    captureConsoleLog();
    const spawnFailure: SpawnServerResult = { ok: false, reason: 'boom' };
    spawnServerMock.mockImplementationOnce(async () => spawnFailure);

    let captured: unknown;
    try {
      await runStart(['--project', tmp, '--detach', 'implement X']);
      throw new Error('expected start to throw');
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('Failed to start server');
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'active'))).toBe(false);
  });

  it('redacts the candidate session id but forwards the raw feature when transcripts are disabled', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp, { persistTranscript: false });
    captureConsoleLog();

    await runStart(['--project', tmp, '--detach', 'add secret oauth login']);

    const sessionIds = readdirSync(join(tmp, SPLITBRIEF_DIR, 'sessions'));
    expect(sessionIds).toHaveLength(1);
    const sessionId = sessionIds[0] ?? '';
    expect(isOpaqueSessionId(sessionId)).toBe(true);
    expect(sessionId).not.toContain('secret');
    expect(sessionId).not.toContain('oauth');

    const artifact = readServerArgsArtifact(tmp);
    expect(artifact.feature).toBe('add secret oauth login');
    expect(artifact.candidate.sessionId).toBe(sessionId);
    expect(artifact).not.toHaveProperty('persistTranscript');
  });

  it('keeps the feature-derived candidate id and raw bootstrap feature when transcripts are enabled', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp, { persistTranscript: true });
    captureConsoleLog();

    await runStart(['--project', tmp, '--detach', 'add email validator']);

    const sessionIds = readdirSync(join(tmp, SPLITBRIEF_DIR, 'sessions'));
    const sessionId = sessionIds[0] ?? '';
    expect(isOpaqueSessionId(sessionId)).toBe(false);
    expect(sessionId).toContain('add-email-validator');

    const artifact = readServerArgsArtifact(tmp);
    expect(artifact.feature).toBe('add email validator');
    expect(artifact.candidate.sessionId).toBe(sessionId);
    expect(artifact).not.toHaveProperty('persistTranscript');
  });

  it('uses an opaque worktree slug for a bare --worktree when persistTranscript is false', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp, { persistTranscript: false });
    captureConsoleLog();

    await runStart(['--project', tmp, 'add secret oauth login', '--worktree', '--detach']);

    const slugs = readdirSync(join(tmp, TREES_DIR));
    expect(slugs).toHaveLength(1);
    const slug = slugs[0] ?? '';
    expect(slug).toMatch(/^session-[a-f0-9]{12}$/);
    expect(slug).not.toContain('secret');
    expect(slug).not.toContain('oauth');
    expect(existsSync(worktreePath(tmp, 'add-secret-oauth-login'))).toBe(false);
  });
});
