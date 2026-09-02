import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { continueCommand } from './command.js';
import type { ContinueDeps } from './command.js';
import { checkServerStatus } from '../../../engine/ipc/lockfile.js';
import type { ServerStatus } from '../../../engine/ipc/lockfile.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { skillsStore } from '../../../stores/project/skills.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { StateAuthorityReceipt } from '../../../core/state/types.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../../core/transcript-policy.js';
import { activeFile, CONFIG_FILE, sessionsRoot, SPLITBRIEF_DIR } from '../../../core/paths.js';
import type { PrepareExecutionInput } from '../../../engine/runners/prepare-execution/prepare-execution.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

type RpcRun = {
  feature: string;
  projectDir: string;
  state: WorkflowState | undefined;
  sessionId: string;
};

type RenderRun = {
  route: ReturnType<typeof routerStore.get>;
  options: Parameters<ContinueDeps['renderApp']>[1];
};

let tmp: string;
let deps: ContinueDeps;
let rpcRuns: RpcRun[];
let renderRuns: RenderRun[];

function makeTmpProject(): string {
  tmp = createTempDir('continue-command-test');
  return tmp;
}

function makeSessionDir(projectDir: string, sessionId: string): string {
  const sessDir = join(projectDir, '.splitbrief', 'sessions', sessionId);
  mkdirSync(sessDir, { recursive: true });
  return sessDir;
}

function writeLockfile(sessDir: string, overrides: Record<string, unknown> = {}): void {
  const data = {
    version: 1,
    pid: process.pid,
    startTimeMs: Date.now(),
    lastAliveMs: Date.now(),
    sessionId: 'test-session',
    mode: 'standard',
    feature: 'test-feature',
    authToken: 'test-auth-token',
    ...overrides,
  };
  writeFileSync(join(sessDir, 'lockfile.json'), JSON.stringify(data));
}

function writeState(sessDir: string, phase: string, extra: Record<string, unknown> = {}): void {
  const state = {
    stateVersion: 3,
    phase,
    feature: 'test-feature',
    currentTaskIndex: 0,
    attempt: 0,
    plannerSessionId: null,
    startedAt: new Date().toISOString(),
    tokenUsage: makeUsage(),
    tasks: [
      {
        id: 'T001',
        title: 'task-1',
        action: 'create',
        file: 'src/test.ts',
        dependsOn: [],
        description: 'Test task',
        tests: [],
        constraints: [],
        typeDefs: '',
        implementationSteps: [],
        status: 'pending',
      },
    ],
    awaitingContinue: false,
    ...extra,
  };
  writeFileSync(join(sessDir, 'state.json'), JSON.stringify(state));
}

function mockPlatform(value: NodeJS.Platform): () => void {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  return () => Object.defineProperty(process, 'platform', { value: original, configurable: true });
}

function forceInteractiveTty(): () => void {
  const stdout = process.stdout as { isTTY?: boolean };
  const originalIsTty = stdout.isTTY;
  const originalCi = process.env['CI'];
  stdout.isTTY = true;
  delete process.env['CI'];
  return () => {
    if (originalIsTty === undefined) delete stdout.isTTY;
    else stdout.isTTY = originalIsTty;
    if (originalCi !== undefined) process.env['CI'] = originalCi;
  };
}

function liveStatus(sessionId: string, feature: string): ServerStatus {
  return {
    alive: true,
    data: {
      version: 1,
      pid: process.pid,
      startTimeMs: Date.now(),
      lastAliveMs: Date.now(),
      sessionId,
      mode: 'standard',
      feature,
      authToken: 'test-auth-token',
    },
  };
}

function liveAuthority(ref: SessionRef): StateAuthorityReceipt {
  return {
    kind: 'usable',
    sessionId: ref.sessionId,
    ownerId: 'owner-1',
    pid: process.pid,
    processStart: String(Date.now()),
    runId: 'run-1',
    acquisitionId: 'acquisition-1',
    fence: 1,
    stateRevision: 1,
    stateDigest: 'a'.repeat(64),
  };
}

function readyReport(projectDir: string): ReadinessReport {
  return {
    generatedAt: '2026-08-04T00:00:00.000Z',
    projectDir,
    status: 'ready',
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
    sections: [],
    metadata: {},
  };
}

async function prepareResume(input: PrepareExecutionInput) {
  if (!('existingSession' in input)) throw new Error('expected resume preparation');
  return {
    kind: 'prepared' as const,
    execution: {
      purpose: 'resume' as const,
      config: input.effectiveConfig,
      preparationId: 'resume-preparation',
      report: readyReport(input.existingSession.projectDir),
      gates: [],
      session: {
        kind: 'existing' as const,
        ref: input.existingSession,
        active: {
          version: 1 as const,
          sessionId: input.existingSession.sessionId,
          generation: '22222222-2222-4222-8222-222222222222',
        },
      },
      runtime: {
        feature: input.feature,
        resumeState: input.resumeState,
        allowRepoRunners: input.policy.allowRepoRunners,
        allowHooks: input.policy.allowHooks,
      },
    },
  };
}

function createDeps(overrides: Partial<ContinueDeps> = {}): ContinueDeps {
  return {
    checkServerStatus,
    initStores: async () => {},
    renderApp: async (_app, options) => {
      renderRuns.push({ route: routerStore.get(), options });
    },
    runHeadless: async () => {},
    runRpc: async ({ prepared }) => {
      rpcRuns.push({
        feature: prepared.runtime.feature,
        projectDir: prepared.session.ref.projectDir,
        state: prepared.runtime.resumeState,
        sessionId: prepared.session.ref.sessionId,
      });
    },
    setupWorkflow: async (opts) => {
      const useFullscreen = opts.fullscreen !== false;
      const useMouse = opts.mouse !== false && useFullscreen;
      return {
        projectDir: opts.project ?? '',
        useFullscreen,
        useMouse,
        useHover: opts.hover === true && useMouse,
      };
    },
    prepareExecution: prepareResume,
    printCrashDiagnostic: async () => ({
      sessionId: 'test',
      status: 'crashed' as const,
      pid: null,
      startedAt: null,
      lastAliveAt: null,
      exitedAt: null,
      signal: null,
      exitCode: null,
      cause: null,
      logTail: null,
    }),
    readStateAuthority: liveAuthority,
    assertStateAuthority: () => {},
    ...overrides,
  };
}

describe('continueCommand', () => {
  beforeEach(() => {
    resetAllStores();
    rpcRuns = [];
    renderRuns = [];
    deps = createDeps();
  });

  afterEach(() => {
    if (tmp) cleanupTempDir(tmp);
    tmp = '';
  });

  it('throws when no session exists and no active pointer', async () => {
    const projectDir = makeTmpProject();

    await expect(continueCommand(undefined, { projectDir }, deps)).rejects.toThrow(
      /no session to continue/,
    );
  });

  it('throws a curated not-found error for an explicit session id with no session dir', async () => {
    const projectDir = makeTmpProject();

    await expect(continueCommand('typo-session', { projectDir }, deps)).rejects.toThrow(
      /session 'typo-session' not found/,
    );
  });

  it('throws when explicit session ID has no state and is not running', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-my-feature');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-my-feature' });

    await expect(continueCommand('2025-04-01-my-feature', { projectDir }, deps)).rejects.toThrow(
      /no usable saved state and is not running/,
    );
  });

  it('throws for a completed session that is not resumable', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-done');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-done' });
    writeState(sessDir, 'complete');

    await expect(continueCommand('2025-04-01-done', { projectDir }, deps)).rejects.toThrow(
      /cannot be resumed/,
    );
  });

  it('routes interrupted sessions to RPC mode when --rpc is passed', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-rpc');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-rpc' });
    writeState(sessDir, 'implementing');

    await continueCommand('2025-04-01-rpc', { projectDir, rpc: true }, deps);

    expect(rpcRuns).toHaveLength(1);
    expect(rpcRuns[0]).toMatchObject({
      feature: 'test-feature',
      projectDir,
      state: { feature: 'test-feature', phase: 'implementing' },
      sessionId: '2025-04-01-rpc',
    });
  });

  it('resumes a reviewing-briefs session listed by ps and addressed by alias number', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-parked';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    writeState(sessDir, 'reviewing-briefs');

    await continueCommand('1', { projectDir, rpc: true }, deps);

    expect(rpcRuns).toHaveLength(1);
    expect(rpcRuns[0]).toMatchObject({
      feature: 'test-feature',
      projectDir,
      state: { phase: 'reviewing-briefs' },
      sessionId,
    });
  });

  it('resume reauthorizes the existing session without creating another', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-exact-resume';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    writeState(sessDir, 'implementing');
    const prepare = vi.fn(prepareResume);
    deps = createDeps({ prepareExecution: prepare });

    await continueCommand(sessionId, { projectDir, rpc: true }, deps);

    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({
      existingSession: { projectDir, sessionId },
      policy: { purpose: 'resume', interaction: 'headless' },
    });
    expect(readdirSync(join(projectDir, SPLITBRIEF_DIR, 'sessions'))).toEqual([sessionId]);
    expect(rpcRuns[0]).toMatchObject({ sessionId, state: { phase: 'implementing' } });
  });

  it('rejects JSON task review before publishing a new active generation', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-json-review';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    writeState(sessDir, 'implementing');
    writeFileSync(
      join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE),
      JSON.stringify(makeConfig({ workflow: { taskReview: 'every' } })),
    );
    const existingActive = JSON.stringify({
      version: 1,
      sessionId,
      generation: '11111111-1111-4111-8111-111111111111',
    });
    writeFileSync(activeFile(projectDir), existingActive);
    const prepare = vi.fn(prepareResume);
    const runHeadless = vi.fn(async () => {});
    deps = createDeps({ prepareExecution: prepare, runHeadless });

    await expect(
      continueCommand(sessionId, { projectDir, json: true }, deps),
    ).rejects.toMatchObject({
      kind: 'cli-error',
      message: expect.stringContaining('workflow.taskReview requires an interactive TUI run'),
    });

    expect(prepare).not.toHaveBeenCalled();
    expect(runHeadless).not.toHaveBeenCalled();
    expect(readFileSync(activeFile(projectDir), 'utf8')).toBe(existingActive);
    expect(readdirSync(sessionsRoot(projectDir))).toEqual([sessionId]);
  });

  it('attaches the workflow screen when the target session is still running', async () => {
    const projectDir = makeTmpProject();
    makeSessionDir(projectDir, '2025-04-01-live');
    deps = createDeps({
      checkServerStatus: async (): Promise<ServerStatus> => ({
        alive: true,
        data: {
          version: 1,
          pid: process.pid,
          startTimeMs: Date.now(),
          lastAliveMs: Date.now(),
          sessionId: '2025-04-01-live',
          mode: 'standard',
          feature: 'live feature',
          authToken: 'test-auth-token',
        },
      }),
    });

    await continueCommand('2025-04-01-live', { projectDir }, deps);

    expect(renderRuns).toHaveLength(1);
    expect(renderRuns[0]?.route).toMatchObject({
      screen: 'workflow',
      execution: {
        kind: 'attached',
        feature: 'live feature',
        sessionId: '2025-04-01-live',
        attach: {
          sockPath: join(projectDir, '.splitbrief', 'sessions', '2025-04-01-live', 'ipc.sock'),
          authToken: 'test-auth-token',
        },
      },
    });
  });

  it('refuses to double-execute when a live interactive session record exists (no auth token)', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-interactive-live';
    makeSessionDir(projectDir, sessionId);
    // An interactive (TUI/headless) run writes a liveness record WITHOUT an authToken — there
    // is no IPC socket to attach to. A `continue` from a second terminal must see it live and
    // refuse, rather than silently double-executing the session.
    deps = createDeps({
      checkServerStatus: async (): Promise<ServerStatus> => ({
        alive: true,
        data: {
          version: 1,
          pid: process.pid,
          startTimeMs: Date.now(),
          lastAliveMs: Date.now(),
          sessionId,
          mode: 'standard',
          feature: 'interactive feature',
        },
      }),
    });

    await expect(continueCommand(sessionId, { projectDir }, deps)).rejects.toThrow(
      /server and owner authority identities do not match/,
    );
    expect(renderRuns).toHaveLength(0);
    expect(rpcRuns).toHaveLength(0);
  });

  it('rejects a live continue when the server identity does not match the owner fence', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-live-mismatch';
    makeSessionDir(projectDir, sessionId);
    deps = createDeps({
      checkServerStatus: async (): Promise<ServerStatus> => {
        const status = liveStatus(sessionId, 'live feature');
        if (status.data === null) throw new Error('expected live status data');
        return { ...status, data: { ...status.data, pid: process.pid + 1 } };
      },
    });

    await expect(continueCommand(sessionId, { projectDir }, deps)).rejects.toThrow(
      `cannot attach to session ${sessionId}: server and owner authority identities do not match`,
    );
    expect(renderRuns).toHaveLength(0);
  });

  it('rejects a live continue when the server process start does not match the owner fence', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-live-start-mismatch';
    makeSessionDir(projectDir, sessionId);
    deps = createDeps({
      checkServerStatus: async (): Promise<ServerStatus> => {
        const status = liveStatus(sessionId, 'live feature');
        if (status.data === null) throw new Error('expected live status data');
        return { ...status, data: { ...status.data, startTimeMs: Date.now() - 10_000 } };
      },
    });

    await expect(continueCommand(sessionId, { projectDir }, deps)).rejects.toThrow(
      `cannot attach to session ${sessionId}: server and owner authority identities do not match`,
    );
    expect(renderRuns).toHaveLength(0);
  });

  it('rejects --json and --rpc together', async () => {
    const projectDir = makeTmpProject();

    await expect(
      continueCommand(undefined, { projectDir, json: true, rpc: true }, deps),
    ).rejects.toThrow(/--json and --rpc cannot be combined/);
  });

  it('rejects --worktree as a start-only flag instead of silently ignoring it', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-wt');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-wt' });
    writeState(sessDir, 'implementing');

    await expect(
      continueCommand('2025-04-01-wt', { projectDir, worktree: 'feature-x' }, deps),
    ).rejects.toThrow(/--worktree is only supported by `splitbrief start`/);
    expect(renderRuns).toHaveLength(0);
    expect(rpcRuns).toHaveLength(0);
  });

  it('rejects a session with an older stateVersion via loadState filtering', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-old');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-old' });
    writeState(sessDir, 'implementing', { stateVersion: 1 });

    await expect(continueCommand('2025-04-01-old', { projectDir }, deps)).rejects.toThrow(
      /no usable saved state/,
    );
  });

  it('prints crash diagnostics for crashed sessions then resumes without exiting', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-crashed';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { sessionId, signal: 'SIGKILL', cause: 'OOM' });
    writeState(sessDir, 'implementing');

    const diagnosticCalls: string[] = [];
    deps = createDeps({
      checkServerStatus: async (): Promise<ServerStatus> => ({
        alive: false,
        crashed: true,
        processAlive: false,
        data: null,
      }),
      printCrashDiagnostic: async (dir) => {
        diagnosticCalls.push(dir);
        return {
          sessionId,
          status: 'crashed',
          pid: null,
          startedAt: null,
          lastAliveAt: null,
          exitedAt: null,
          signal: 'SIGKILL',
          exitCode: null,
          cause: 'OOM',
          logTail: null,
        };
      },
    });

    await continueCommand(sessionId, { projectDir }, deps);

    expect(diagnosticCalls).toHaveLength(1);
    expect(renderRuns).toHaveLength(1);
  });

  it('refuses to resume when the server process is alive but unresponsive (stale heartbeat)', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-unresponsive';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { sessionId });
    writeState(sessDir, 'implementing');

    const diagnosticCalls: string[] = [];
    deps = createDeps({
      checkServerStatus: async (): Promise<ServerStatus> => ({
        alive: false,
        crashed: true,
        processAlive: true,
        data: {
          version: 1,
          pid: 4242,
          startTimeMs: Date.now(),
          lastAliveMs: Date.now() - 999_999,
          sessionId,
          mode: 'standard',
          feature: 'unresponsive feature',
        },
      }),
      printCrashDiagnostic: async (dir) => {
        diagnosticCalls.push(dir);
        return {
          sessionId,
          status: 'crashed',
          pid: 4242,
          startedAt: null,
          lastAliveAt: null,
          exitedAt: null,
          signal: null,
          exitCode: null,
          cause: null,
          logTail: null,
        };
      },
    });

    await expect(continueCommand(sessionId, { projectDir }, deps)).rejects.toThrow(
      /server process 4242 exists but is unresponsive — kill it first/,
    );
    expect(renderRuns).toHaveLength(0);
    expect(rpcRuns).toHaveLength(0);
    expect(diagnosticCalls).toHaveLength(0);
  });

  it('preserves the saved workflow mode on resume when --mode is not passed', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-saved-mode');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-saved-mode' });
    writeState(sessDir, 'implementing', { mode: 'speckit', approve: 'all' });

    await continueCommand('2025-04-01-saved-mode', { projectDir, rpc: true }, deps);

    expect(rpcRuns).toHaveLength(1);
    expect(rpcRuns[0]?.state).toMatchObject({ mode: 'speckit', approve: 'all' });
  });

  it('rehydrates the skills selection from persisted state on resume', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-skills');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-skills' });
    writeState(sessDir, 'implementing', { selectedSkills: ['typescript', 'react'] });

    await continueCommand('2025-04-01-skills', { projectDir }, deps);

    expect(renderRuns).toHaveLength(1);
    expect([...skillsStore.get().selected].sort()).toEqual(['react', 'typescript']);
  });

  it('overrides the saved workflow mode when --mode is passed explicitly', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-override-mode');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-override-mode' });
    writeState(sessDir, 'implementing', { mode: 'speckit', approve: 'all' });

    await continueCommand(
      '2025-04-01-override-mode',
      { projectDir, rpc: true, mode: 'quick' },
      deps,
    );

    expect(rpcRuns).toHaveLength(1);
    expect(rpcRuns[0]?.state).toMatchObject({ mode: 'quick' });
  });

  it('strips terminal control bytes from the pre-TUI resume status line', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-osc');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-osc' });
    writeState(sessDir, 'implementing', { feature: 'add \u001b]0;pwned\u0007login' });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let logged: string[] = [];
    try {
      await continueCommand('2025-04-01-osc', { projectDir }, deps);
    } finally {
      logged = logSpy.mock.calls.map((call) => call.join(' '));
      logSpy.mockRestore();
    }

    const resumeLine = logged.find((line) => line.includes('Resuming:'));
    expect(resumeLine).toBeDefined();
    expect(resumeLine).toContain('add login');
    expect(resumeLine).not.toContain('\u001b');
    expect(resumeLine).not.toContain('pwned');
  });

  it('forwards --hover to the attach render so any-motion mouse mode is enabled', async () => {
    const projectDir = makeTmpProject();
    makeSessionDir(projectDir, '2025-04-01-hover-live');
    deps = createDeps({
      checkServerStatus: async (): Promise<ServerStatus> =>
        liveStatus('2025-04-01-hover-live', 'live feature'),
    });

    const restoreTty = forceInteractiveTty();
    try {
      await continueCommand('2025-04-01-hover-live', { projectDir, hover: true }, deps);
    } finally {
      restoreTty();
    }

    expect(renderRuns).toHaveLength(1);
    expect(renderRuns[0]?.route).toMatchObject({ screen: 'workflow' });
    expect(renderRuns[0]?.options).toMatchObject({ fullscreen: true, mouse: true, hover: true });
  });

  it('forwards --no-fullscreen and --no-mouse to the attach render', async () => {
    const projectDir = makeTmpProject();
    makeSessionDir(projectDir, '2025-04-01-render-flags');
    deps = createDeps({
      checkServerStatus: async (): Promise<ServerStatus> =>
        liveStatus('2025-04-01-render-flags', 'live feature'),
    });

    const restoreTty = forceInteractiveTty();
    try {
      await continueCommand(
        '2025-04-01-render-flags',
        { projectDir, fullscreen: false, mouse: false },
        deps,
      );
    } finally {
      restoreTty();
    }

    expect(renderRuns[0]?.options).toMatchObject({
      fullscreen: false,
      mouse: false,
      hover: false,
    });
  });

  it('omits the feature on the resume status line when persistTranscript is false', async () => {
    const projectDir = makeTmpProject();
    mkdirSync(join(projectDir, SPLITBRIEF_DIR), { recursive: true });
    writeFileSync(
      join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE),
      [
        'version: 3',
        'planner:',
        '  kind: cli',
        '  tool: claude-code',
        'implementer:',
        '  kind: api',
        '  provider: ollama',
        '  apiBase: http://localhost:11434/v1',
        '  model: qwen2.5-coder:7b',
        '  contextLength: 32768',
        'workflow:',
        '  persistTranscript: false',
        '  mode: standard',
      ].join('\n'),
    );
    const sessDir = makeSessionDir(projectDir, '2025-04-01-private');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-private' });
    writeState(sessDir, 'implementing', { feature: 'secret oauth login' });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await continueCommand('2025-04-01-private', { projectDir }, deps);
    } finally {
      const resumeLine = logSpy.mock.calls
        .map((call) => call.join(' '))
        .find((line) => line.includes('Resuming:'));
      expect(resumeLine).toBeDefined();
      expect(resumeLine).toContain(TRANSCRIPT_OMITTED_MESSAGE);
      expect(resumeLine).not.toContain('secret');
      logSpy.mockRestore();
    }
  });

  it('omits the feature on the resume status line for a transcript-private session when current config allows transcripts', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-session-abcdef123456';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    writeState(sessDir, 'implementing', { feature: 'secret oauth login' });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await continueCommand(sessionId, { projectDir }, deps);
    } finally {
      const resumeLine = logSpy.mock.calls
        .map((call) => call.join(' '))
        .find((line) => line.includes('Resuming:'));
      expect(resumeLine).toBeDefined();
      expect(resumeLine).toContain(TRANSCRIPT_OMITTED_MESSAGE);
      expect(resumeLine).not.toContain('secret');
      logSpy.mockRestore();
    }
  });

  it('does not enable hover on the attach path when --hover is absent', async () => {
    const projectDir = makeTmpProject();
    makeSessionDir(projectDir, '2025-04-01-nohover-live');
    deps = createDeps({
      checkServerStatus: async (): Promise<ServerStatus> =>
        liveStatus('2025-04-01-nohover-live', 'live feature'),
    });

    const restoreTty = forceInteractiveTty();
    try {
      await continueCommand('2025-04-01-nohover-live', { projectDir }, deps);
    } finally {
      restoreTty();
    }

    expect(renderRuns).toHaveLength(1);
    expect(renderRuns[0]?.route).toMatchObject({ screen: 'workflow' });
    expect(renderRuns[0]?.options?.hover).toBe(false);
  });

  it('resumes an interrupted session on Windows instead of rejecting with the attach guard', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-win-resume');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-win-resume' });
    writeState(sessDir, 'implementing');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const restorePlatform = mockPlatform('win32');
    try {
      await continueCommand('2025-04-01-win-resume', { projectDir }, deps);
    } finally {
      restorePlatform();
      logSpy.mockRestore();
    }

    expect(renderRuns).toHaveLength(1);
  });

  it('still rejects a live attach target on Windows', async () => {
    const projectDir = makeTmpProject();
    makeSessionDir(projectDir, '2025-04-01-win-live');
    deps = createDeps({
      checkServerStatus: async (): Promise<ServerStatus> =>
        liveStatus('2025-04-01-win-live', 'live feature'),
    });

    const restorePlatform = mockPlatform('win32');
    try {
      await expect(continueCommand('2025-04-01-win-live', { projectDir }, deps)).rejects.toThrow(
        /not supported on Windows/,
      );
    } finally {
      restorePlatform();
    }

    expect(renderRuns).toHaveLength(0);
  });
});
