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
import { CONFIG_FILE, SPLITBRIEF_DIR, TREES_DIR, worktreePath } from '../../../src/core/paths.js';
import { isCliError } from '../../../src/cli/errors.js';
import {
  featureForTranscriptPolicy,
  isOpaqueSessionId,
} from '../../../src/core/sessions/lifecycle.js';
import { parseIpcServerArgs } from '../../../src/engine/ipc/server-args.js';
import type {
  SpawnServerOptions,
  SpawnServerResult,
} from '../../../src/engine/ipc/spawn-server.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../../src/core/transcript-policy.js';
import { formatDetachedAttachHint } from '../../../src/cli/commands/attach-hint.js';

setupStartCommandIntegration();

describe('start command — detached', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.PLANNER_KEY;
  });

  it('applies --worktree before --detach creates detached session artifacts', async () => {
    const tmp = getStartCommandTmp();
    const wtPath = worktreePath(tmp, 'detached-feature');
    spawnServerMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '--worktree', 'detached-feature', '--detach', 'implement X']);

    const artifact = readSingleSessionArtifact(wtPath, 'server-args.json') as {
      projectDir?: string;
      configPath?: string;
    };
    expect(artifact.projectDir).toBe(wtPath);
    expect(artifact.configPath).toBe(join(wtPath, SPLITBRIEF_DIR, CONFIG_FILE));

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => call.join(' '))
      .join('\n');
    expect(output).toContain('splitbrief attach');
    expect(output).toContain('--project');
    expect(output).not.toContain('cd ');
  });

  it('prints a shell-safe attach hint with --project for paths containing spaces', async () => {
    const tmp = getStartCommandTmp();
    const spaced = join(tmp, 'my project');
    mkdirSync(spaced, { recursive: true });
    createTestGitRepo(spaced);
    writeReadyReadinessFixtures(spaced);
    spawnServerMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', spaced, '--detach', 'implement X']);

    const sessionIds = readdirSync(join(spaced, SPLITBRIEF_DIR, 'sessions'));
    expect(sessionIds).toHaveLength(1);
    const sessionId = sessionIds[0] ?? '';

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => call.join(' '))
      .join('\n');
    const expectedRun = `Run: ${formatDetachedAttachHint(spaced, sessionId)}`;
    expect(output).toContain(expectedRun);
    expect(output).not.toContain('cd ');
  });

  it('preserves config workflow mode when --detach omits --mode', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    const configFilePath = join(tmp, SPLITBRIEF_DIR, CONFIG_FILE);
    writeFileSync(
      configFilePath,
      readFileSync(configFilePath, 'utf-8').replace('mode: standard', 'mode: quick'),
    );
    spawnServerMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '--detach', 'implement X']);

    expect(spawnServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'quick',
        overrides: expect.not.objectContaining({ mode: expect.anything() }),
      }),
    );
    const artifact = readSingleSessionArtifact(tmp, 'server-args.json') as {
      mode?: string;
      overrides?: { mode?: string };
    };
    expect(artifact.mode).toBe('quick');
    expect(artifact.overrides?.mode).toBeUndefined();
  });

  it('persists detached CLI overrides in the server args artifact', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.PLANNER_KEY = 'test-planner-key';
    spawnServerMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});

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
      '--planner-api-key-env',
      'PLANNER_KEY',
      '--planner-args',
      '--planner-json',
      '--planner-output-format',
      'stream-json',
      '--planner-context-length',
      '200000',
      '--implementer',
      'openrouter',
      '--implementer-model',
      'qwen/qwen3-coder',
      '--implementer-command',
      'build-it',
      '--implementer-api-base',
      'https://openrouter.ai/api/v1',
      '--implementer-api-key-env',
      'OPENROUTER_API_KEY',
      '--implementer-args',
      '--cheap-mode',
      '--implementer-args',
      'fast',
      '--implementer-output-format',
      'opencode',
      '--implementer-context-length',
      '131072',
      '--model',
      'alias-model',
      '--provider',
      'deepseek',
      '--approve',
      'all',
      '--budget',
      '4.25',
      '--planner-effort',
      'high',
      '--mode',
      'quick',
      '--auto',
      'implement X',
    ]);

    const artifact = readSingleSessionArtifact(tmp, 'server-args.json') as {
      mode?: string;
      configPath?: string;
      overrides?: unknown;
    };
    expect(artifact).toMatchObject({
      mode: 'quick',
      configPath: join(tmp, SPLITBRIEF_DIR, CONFIG_FILE),
      overrides: {
        planner: {
          tool: 'codex',
          model: 'gpt-5',
          command: 'plan-it',
          apiBase: 'https://planner.example/v1',
          apiKey: 'env:PLANNER_KEY',
          args: ['--planner-json'],
          outputFormat: 'stream-json',
          contextLength: 200_000,
        },
        implementer: {
          tool: 'openrouter',
          model: 'qwen/qwen3-coder',
          command: 'build-it',
          apiBase: 'https://openrouter.ai/api/v1',
          apiKey: 'env:OPENROUTER_API_KEY',
          args: ['--cheap-mode', 'fast'],
          outputFormat: 'opencode',
          contextLength: 131_072,
        },
        autoApprove: true,
        approve: 'all',
        mode: 'quick',
        budget: 4.25,
        plannerEffort: 'high',
      },
    });
  });

  it('prints config load warnings to stderr on the detached path before spawning the server', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    const configFilePath = join(tmp, SPLITBRIEF_DIR, CONFIG_FILE);
    writeFileSync(
      configFilePath,
      [
        'version: 2',
        'planner:',
        '  kind: api',
        '  provider: ollama',
        '  apiBase: http://localhost:11434/v1',
        '  model: qwen2.5-coder:7b',
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
    chmodSync(configFilePath, 0o600);
    spawnServerMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderrChunks: string[] = [];
    let warningsBeforeSpawn = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    spawnServerMock.mockImplementationOnce(async (opts: SpawnServerOptions) => {
      warningsBeforeSpawn = stderrChunks.join('');
      mkdirSync(opts.sessionDir, { recursive: true });
      return { ok: true, pid: 1234, sessionId: opts.sessionId };
    });

    await runStart(['--project', tmp, '--detach', 'implement X']);

    expect(spawnServerMock).toHaveBeenCalledTimes(1);
    expect(warningsBeforeSpawn).toContain('config.version 2 is deprecated');
  });

  it('normalizes the legacy --mode full alias through nested detached overrides', async () => {
    const tmp = getStartCommandTmp();
    spawnServerMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '--detach', '--mode', 'full', 'implement X']);

    const artifact = readSingleSessionArtifact(tmp, 'server-args.json');
    const parsed = parseIpcServerArgs(artifact);

    expect(parsed).not.toBeNull();
    expect(parsed?.mode).toBe('speckit');
    expect(parsed?.overrides.mode).toBe('speckit');
  });

  it('clears the active pointer when detached server spawn fails', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    vi.spyOn(console, 'log').mockImplementation(() => {});
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

  it('redacts the generated session id but forwards the raw feature to the detached planner when persistTranscript is false', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp, { persistTranscript: false });
    spawnServerMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '--detach', 'add secret oauth login']);

    expect(spawnServerMock).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnServerMock.mock.calls[0]?.[0];
    expect(spawnArgs?.persistTranscript).toBe(false);

    const sessionIds = readdirSync(join(tmp, SPLITBRIEF_DIR, 'sessions'));
    expect(sessionIds).toHaveLength(1);
    const sessionId = sessionIds[0] ?? '';
    expect(isOpaqueSessionId(sessionId)).toBe(true);
    expect(sessionId).not.toContain('secret');
    expect(sessionId).not.toContain('oauth');

    const artifact = readSingleSessionArtifact(tmp, 'server-args.json') as {
      feature?: string;
      persistTranscript?: boolean;
    };
    expect(artifact.feature).toBe('add secret oauth login');
    expect(artifact.persistTranscript).toBe(false);
    expect(
      featureForTranscriptPolicy(artifact.feature ?? '', artifact.persistTranscript ?? true),
    ).toBe(TRANSCRIPT_OMITTED_MESSAGE);
  });

  it('keeps the raw feature in the generated session id and detached metadata when persistTranscript is true', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp, { persistTranscript: true });
    spawnServerMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '--detach', 'add email validator']);

    const spawnArgs = spawnServerMock.mock.calls[0]?.[0];
    expect(spawnArgs?.persistTranscript).toBe(true);

    const sessionIds = readdirSync(join(tmp, SPLITBRIEF_DIR, 'sessions'));
    const sessionId = sessionIds[0] ?? '';
    expect(isOpaqueSessionId(sessionId)).toBe(false);
    expect(sessionId).toContain('add-email-validator');

    const artifact = readSingleSessionArtifact(tmp, 'server-args.json') as { feature?: string };
    expect(artifact.feature).toBe('add email validator');
  });

  it('uses an opaque worktree slug for a bare --worktree when persistTranscript is false', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp, { persistTranscript: false });
    spawnServerMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});

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
