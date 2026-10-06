import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  createHeadlessGitProject,
  preparedHeadlessExecution,
  writeHeadlessConfigYaml,
  writeMinimalHeadlessConfigYaml,
} from '#testing/helpers/headless-project.js';
import { createInitialState, transition } from '../core/state/machine.js';
import { ensureSessionDir } from '../core/paths-io.js';
import { loadState, saveState } from '../core/state/persistence.js';
import { HeadlessJsonRecordSchema } from '../engine/events/public-json.js';
import { writeActive } from '../core/sessions/active-pointer.js';
import { buildContextOverflowRecoveryIssue } from '../engine/orchestrator/recovery/builders/task.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { formatResumeCommand } from '../core/recovery/resume-command.js';
import { emitRecoveryAndFailIfPending, runHeadless } from './headless.js';
import { saveSummary } from '../core/sessions/io.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import type { Implementer } from '../engine/implementers/types.js';
import type { Planner } from '../engine/planners/types.js';
import { typedCallFromTasks } from '#testing/helpers/typed-planner.js';

// The two terminal guards read state and session after the run; skipping the run
// itself is what makes them reachable without driving a whole workflow.
const skipTheRun: { enabled: boolean } = { enabled: false };
vi.mock('../engine/orchestrator/run/workflow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/orchestrator/run/workflow.js')>();
  return {
    ...actual,
    runWorkflow: async (opts: Parameters<typeof actual.runWorkflow>[0]) =>
      skipTheRun.enabled ? undefined : actual.runWorkflow(opts),
  };
});

let stderrSpy: ReturnType<typeof vi.spyOn>;
let dirs: string[] = [];

describe('runHeadless — every pending recovery status fails the run', () => {
  let stdoutChunks: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let planner: Planner;
  let implementer: Implementer;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    planner = makePlanner();
    implementer = makeImplementer();
    stdoutChunks = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    vi.clearAllMocks();
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  it.each(['awaiting-user', 'applying'] as const)(
    'a run ending with a %s recovery exits 1, emits the record and names the resolution route',
    async (status) => {
      const projectDir = createHeadlessGitProject(`headless-pending-${status}`);
      dirs.push(projectDir);
      writeMinimalHeadlessConfigYaml(projectDir);
      const sessionId = `sess-headless-${status}`;
      ensureSessionDir(projectDir, sessionId);
      writeActive({ projectDir: projectDir, sessionId: sessionId });

      const task = makeTask({ id: 'T001' });
      const issue = {
        ...buildContextOverflowRecoveryIssue({
          task,
          phase: 'implementing',
          createdAt: '2026-04-28T12:00:00.000Z',
        }),
        status,
      };
      const state = transition(
        {
          ...createInitialState('recover me'),
          phase: 'implementing',
          tasks: [task],
          plannerTool: 'claude-code',
          implementerTool: 'ollama',
        },
        { type: 'SET_PENDING_RECOVERY', issue },
      );
      saveState({ projectDir, sessionId }, state);

      const error = await runHeadless({
        prepared: preparedHeadlessExecution({
          projectDir,
          sessionId,
          feature: 'recover me',
          resumeState: state,
        }),
        _planner: planner,
        _implementer: implementer,
      }).then(
        () => {
          throw new Error('runHeadless unexpectedly resolved');
        },
        (err: { exitCode?: number; message?: string }) => err,
      );

      expect(error).toMatchObject({
        exitCode: 1,
        message: expect.stringMatching(/^Seat down \(context-overflow\): /),
      });
      expect(error.message).toContain('Recommended: retry-same-worker');
      expect(error.message).toContain(
        `Continue with: splitbrief continue ${sessionId} --action retry [--plain|--json]`,
      );

      const jsonLines = stdoutChunks
        .join('')
        .trim()
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => HeadlessJsonRecordSchema.parse(JSON.parse(line)));
      expect(jsonLines).toContainEqual(
        expect.objectContaining({
          type: 'recovery_required',
          halt: 'seat-down',
          reason: 'context-overflow',
          status,
          resumeCommand: formatResumeCommand(sessionId, issue),
        }),
      );
    },
  );

  it('pending recovery prints the continue line', async () => {
    const projectDir = createHeadlessGitProject('headless-continue-line');
    dirs.push(projectDir);
    writeMinimalHeadlessConfigYaml(projectDir);
    const sessionId = 'sess-headless-continue-line';
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });

    const task = makeTask({ id: 'T001' });
    const issue = makeRecoveryIssue({ recommendedAction: 'skip-current-task' });
    const state = transition(
      { ...createInitialState('recover me'), phase: 'implementing', tasks: [task] },
      { type: 'SET_PENDING_RECOVERY', issue },
    );
    saveState({ projectDir, sessionId }, state);

    const error = await runHeadless({
      prepared: preparedHeadlessExecution({
        projectDir,
        sessionId,
        feature: 'recover me',
        resumeState: state,
      }),
      _planner: planner,
      _implementer: implementer,
    }).then(
      () => {
        throw new Error('runHeadless unexpectedly resolved');
      },
      (err: { exitCode?: number; message?: string }) => err,
    );

    expect(error.exitCode).toBe(1);
    expect(error.message).toContain(
      `Continue with: splitbrief continue ${sessionId} --action skip [--plain|--json]`,
    );
  });

  it('writes no NDJSON record under --plain; the failure still names the route', async () => {
    const projectDir = createHeadlessGitProject('headless-pending-plain');
    dirs.push(projectDir);
    writeMinimalHeadlessConfigYaml(projectDir);
    const sessionId = 'sess-headless-plain';
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });

    const task = makeTask({ id: 'T001' });
    const issue = buildContextOverflowRecoveryIssue({
      task,
      phase: 'implementing',
      createdAt: '2026-04-28T12:00:00.000Z',
    });
    const state = transition(
      {
        ...createInitialState('recover me'),
        phase: 'implementing',
        tasks: [task],
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      { type: 'SET_PENDING_RECOVERY', issue },
    );
    saveState({ projectDir, sessionId }, state);

    const error = await runHeadless({
      prepared: preparedHeadlessExecution({
        projectDir,
        sessionId,
        feature: 'recover me',
        resumeState: state,
      }),
      plain: true,
      _planner: planner,
      _implementer: implementer,
    }).then(
      () => {
        throw new Error('runHeadless unexpectedly resolved');
      },
      (err: { exitCode?: number; message?: string }) => err,
    );

    expect(error).toMatchObject({ exitCode: 1 });
    expect(error.message).toContain('Seat down (context-overflow)');
    expect(stdoutChunks.join('')).not.toContain('recovery_required');
  });
});

describe('emitRecoveryAndFailIfPending — a usage-limit halt', () => {
  // The halt's stored words name no clock, so the line spells the reset when it is printed, in the
  // words the workflow header uses: dated only once the reset is not today.
  it.each([
    [new Date(2026, 6, 13, 9, 30), 'resets 17:00'],
    [new Date(2026, 6, 14, 9, 30), 'resets Jul 13, 17:00'],
  ])('printed at %s, names the reset as %j', (now, note) => {
    const message =
      'Ollama hit its usage limit. Wait for the limit to reset or change the BUILD tool, then continue.';
    const state = {
      ...createInitialState('recover me'),
      pendingRecovery: makeRecoveryIssue({
        reason: 'runner-usage-limit',
        message,
        resetAt: new Date(2026, 6, 13, 17).toISOString(),
      }),
    };
    vi.useFakeTimers({ toFake: ['Date'], now });
    try {
      expect(() =>
        emitRecoveryAndFailIfPending({ state, sessionId: 'sess-limit', writeRecord: vi.fn() }),
      ).toThrow(`Seat down (runner-usage-limit): ${message} (${note})\n`);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('emitRecoveryAndFailIfPending — an answered partial Apply', () => {
  const partial = makeRecoveryIssue({
    reason: 'apply-partial',
    phase: 'complete',
    message: 'Apply stopped part way',
    availableActions: ['retry-same-worker', 'restore-backup', 'end-run'],
    recommendedAction: 'retry-same-worker',
  });

  it.each(['retry-same-worker', 'restore-backup'] as const)(
    'lets a partial Apply answered with %s reach the run, which carries it out',
    (selectedAction) => {
      const state = {
        ...createInitialState('apply me'),
        pendingRecovery: { ...partial, status: 'applying' as const, selectedAction },
      };
      expect(() =>
        emitRecoveryAndFailIfPending({ state, sessionId: 'sess-apply', writeRecord: vi.fn() }),
      ).not.toThrow();
    },
  );

  it('still stops on a partial Apply nobody answered, as a halt that needs you', () => {
    const state = { ...createInitialState('apply me'), pendingRecovery: partial };
    const writeRecord = vi.fn();
    expect(() =>
      emitRecoveryAndFailIfPending({ state, sessionId: 'sess-apply', writeRecord }),
    ).toThrow('Needs you (apply-partial): Apply stopped part way\nRecommended: retry-same-worker');
    expect(writeRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'recovery_required',
        halt: 'needs-you',
        reason: 'apply-partial',
      }),
      process.stdout,
    );
  });
});

describe('runHeadless — with a reviewer configured', () => {
  let stdoutChunks: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutChunks = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    vi.clearAllMocks();
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  it('reports a resumed pending recovery before the workflow starts, reviewer or not', async () => {
    const projectDir = createHeadlessGitProject('headless-reviewer');
    dirs.push(projectDir);
    writeMinimalHeadlessConfigYaml(projectDir, { reviewerTool: 'codex' });
    const sessionId = 'sess-headless-reviewer';
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });

    const task = makeTask({ id: 'T001' });
    const state = transition(
      {
        ...createInitialState('review me'),
        phase: 'implementing',
        tasks: [task],
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      {
        type: 'SET_PENDING_RECOVERY',
        issue: buildContextOverflowRecoveryIssue({
          task,
          phase: 'implementing',
          createdAt: '2026-04-28T12:00:00.000Z',
        }),
      },
    );
    saveState({ projectDir, sessionId }, state);

    const prepared = preparedHeadlessExecution({
      projectDir,
      sessionId,
      feature: 'review me',
      resumeState: state,
    });
    expect(prepared.config.reviewer).toMatchObject({ kind: 'cli', tool: 'codex' });

    await expect(
      runHeadless({
        prepared,
        _planner: makePlanner(),
        _implementer: makeImplementer(),
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('Seat down (context-overflow)') });

    const lines = stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => HeadlessJsonRecordSchema.parse(JSON.parse(line)));
    expect(lines).toContainEqual(expect.objectContaining({ type: 'recovery_required' }));
  });

  it('runs the workflow through to the configured reviewer seat', async () => {
    const projectDir = createHeadlessGitProject('headless-reviewer-run');
    dirs.push(projectDir);
    writeHeadlessConfigYaml(projectDir, [
      'version: 3',
      'planner:',
      '  kind: cli',
      '  tool: claude-code',
      'reviewer:',
      '  kind: shell',
      '  command: /bin/cat',
      '  output_format: text',
      'implementer:',
      '  kind: api',
      '  provider: ollama',
      '  service: ollama',
      '  offering: local',
      '  api_base: http://localhost:11434/v1',
      '  model: qwen2.5-coder:7b',
      '  context_length: 32768',
      'validation:',
      '  typecheck: false',
      '  lint: false',
      '  test: false',
      '  test_command: "noop"',
      'workflow:',
      '  approve: none',
    ]);
    const sessionId = 'sess-headless-reviewer-run';
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });

    const prepared = preparedHeadlessExecution({
      projectDir,
      sessionId,
      feature: 'review me for real',
    });
    expect(prepared.purpose).toBe('new-workflow');
    expect(prepared.gates).toContainEqual(expect.objectContaining({ slot: { role: 'reviewer' } }));

    const planner = makePlanner({
      typedCall: typedCallFromTasks(
        [
          makeTask({
            scope: { inBounds: ['src/hello.ts'], outOfBounds: ['everything else'] },
            evidence: ['src/hello.test.ts passes'],
            typeDefs: 'export type Hello = string;',
          }),
        ],
        { inputTokens: 50, outputTokens: 25 },
      ),
    });

    // `/bin/cat` echoes the prompt back, so the verdict never parses: the review
    // fails after its repair and the run exits 1 with a seat-protocol-error recovery.
    const error = await runHeadless({
      prepared,
      _planner: planner,
      _implementer: makeImplementer(),
    }).then(
      () => {
        throw new Error('runHeadless unexpectedly resolved');
      },
      (err: { exitCode?: number; message?: string }) => err,
    );
    expect(error).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('Seat down (seat-protocol-error)'),
    });

    const lines = stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => HeadlessJsonRecordSchema.parse(JSON.parse(line)));
    const events = lines.flatMap((line) => (line.type === 'event' ? [line.data] : []));
    expect(events).toContainEqual(expect.objectContaining({ type: 'workflow_started' }));
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'workflow_config', reviewerTool: 'shell' }),
    );
    expect(planner.review).not.toHaveBeenCalled();
    // The reviewer named no verdict, so nothing is settled: the run halts on the
    // review seat at the phase it can be re-entered on, with no review status.
    const halted = loadState({ projectDir, sessionId });
    expect(halted?.reviewStatus).toBeUndefined();
    expect(halted?.phase).toBe('final-review');
    expect(halted?.pendingRecovery).toMatchObject({
      reason: 'seat-protocol-error',
      seat: 'review',
    });
  }, 30_000);
});

describe('runHeadless — the run\u2019s terminal outcome sets the exit code', () => {
  let stdoutChunks: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  function records() {
    return stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => HeadlessJsonRecordSchema.parse(JSON.parse(line)));
  }

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutChunks = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    skipTheRun.enabled = true;
  });

  afterEach(() => {
    skipTheRun.enabled = false;
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  function seedFinishedSession(
    name: string,
    state: Partial<WorkflowState>,
  ): { projectDir: string; sessionId: string } {
    const projectDir = createHeadlessGitProject(name);
    dirs.push(projectDir);
    writeMinimalHeadlessConfigYaml(projectDir);
    const sessionId = `sess-${name}`;
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });
    saveState(
      { projectDir, sessionId },
      { ...createInitialState('finish me'), phase: 'complete', ...state },
    );
    return { projectDir, sessionId };
  }

  async function runAndCatch(projectDir: string, sessionId: string) {
    return runHeadless({
      prepared: preparedHeadlessExecution({ projectDir, sessionId, feature: 'finish me' }),
    }).then(
      () => {
        throw new Error('runHeadless unexpectedly resolved');
      },
      (err: { exitCode?: number; message?: string }) => err,
    );
  }

  it('exit 1 on failed review', async () => {
    const { projectDir, sessionId } = seedFinishedSession('review-failed', {
      reviewStatus: 'failed',
    });
    saveSummary(
      { projectDir, sessionId },
      {
        id: sessionId,
        feature: 'finish me',
        startedAt: Date.now(),
        completedAt: Date.now(),
        stateVersion: 4,
        status: 'complete',
        summary: makeSummary({ review: { verdict: 'fail', critical: 2, warnings: 0, notes: 0 } }),
      },
    );

    const error = await runAndCatch(projectDir, sessionId);

    expect(error).toMatchObject({
      exitCode: 1,
      message: 'Final review failed with 2 blocking findings; see review.md',
    });
    expect(records()).toContainEqual({
      type: 'final_review_failed',
      sessionId,
      blocking: 2,
    });
  });

  it('a run left in final-review emits its own record, not the failed one', async () => {
    const { projectDir, sessionId } = seedFinishedSession('review-incomplete', {
      phase: 'final-review',
    });

    const error = await runAndCatch(projectDir, sessionId);

    expect(error).toMatchObject({
      exitCode: 1,
      message: 'Final review did not pass \u2014 workflow is incomplete.',
    });
    expect(records()).toEqual([{ type: 'final_review_incomplete', sessionId }]);
  });

  it('cancelled session exits 1', async () => {
    const { projectDir, sessionId } = seedFinishedSession('cancelled', {});
    saveSummary(
      { projectDir, sessionId },
      {
        id: sessionId,
        feature: 'finish me',
        startedAt: Date.now(),
        completedAt: Date.now(),
        stateVersion: 4,
        status: 'ended',
        summary: null,
      },
    );

    const error = await runAndCatch(projectDir, sessionId);

    expect(error).toMatchObject({ exitCode: 1, message: 'Workflow was cancelled.' });
  });

  it('a run that passed review in a workspace ends ready to apply and exits 0', async () => {
    const { projectDir, sessionId } = seedFinishedSession('ready', {
      reviewStatus: 'passed',
      workspace: {
        kind: 'worktree',
        path: '/nonexistent/splitbrief-ready-workspace',
        base: { snapshotId: 'workspace-base', head: null },
      },
    });
    saveSummary(
      { projectDir, sessionId },
      {
        id: sessionId,
        feature: 'finish me',
        startedAt: Date.now(),
        completedAt: null,
        stateVersion: 4,
        status: 'open',
        summary: null,
      },
    );

    await runHeadless({
      prepared: preparedHeadlessExecution({ projectDir, sessionId, feature: 'finish me' }),
    });

    expect(stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('')).toContain(
      [
        `Run ${sessionId} is ready to apply.`,
        `Apply with: splitbrief continue ${sessionId} --action apply`,
        `Discard with: splitbrief continue ${sessionId} --action discard`,
      ].join('\n'),
    );
    expect(records()).toEqual([
      {
        type: 'ready_to_apply',
        sessionId,
        override: false,
        applyCommand: `splitbrief continue ${sessionId} --action apply`,
        discardCommand: `splitbrief continue ${sessionId} --action discard`,
      },
    ]);
  });

  it('a run accepted as is in a workspace ends ready to apply as an override', async () => {
    const { projectDir, sessionId } = seedFinishedSession('ready-override', {
      reviewStatus: 'failed',
      acceptedAsIs: { at: '2026-09-01T00:00:00.000Z', findings: ['F1'] },
      workspace: {
        kind: 'worktree',
        path: '/nonexistent/splitbrief-ready-workspace',
        base: { snapshotId: 'workspace-base', head: null },
      },
    });

    await runHeadless({
      prepared: preparedHeadlessExecution({ projectDir, sessionId, feature: 'finish me' }),
    });

    expect(records()).toEqual([
      {
        type: 'ready_to_apply',
        sessionId,
        override: true,
        applyCommand: `splitbrief continue ${sessionId} --action apply`,
        discardCommand: `splitbrief continue ${sessionId} --action discard`,
      },
    ]);
  });

  it.each(['checkout', 'no-workspace'] as const)(
    'a %s run accepted as is exits 0 and keeps its failed review',
    async (kind) => {
      const { projectDir, sessionId } = seedFinishedSession(`accepted-${kind}`, {
        reviewStatus: 'failed',
        acceptedAsIs: { at: '2026-09-01T00:00:00.000Z', findings: ['F1'] },
        ...(kind === 'checkout' && {
          workspace: {
            kind: 'checkout',
            path: '/checkout',
            base: { snapshotId: 'base', head: null },
          },
        }),
      });
      await runHeadless({
        prepared: preparedHeadlessExecution({ projectDir, sessionId, feature: 'finish me' }),
      });
      expect(loadState({ projectDir, sessionId })?.reviewStatus).toBe('failed');
      expect(records()).toEqual([]);
    },
  );

  it('a run whose state recorded a failure exits 1, whatever its session row says', async () => {
    const { projectDir, sessionId } = seedFinishedSession('failed', {
      phase: 'implementing',
      lastFailure: {
        step: { kind: 'planner', call: 'plan' },
        message: 'Planning failed.',
        at: '2026-09-01T00:00:00.000Z',
      },
    });

    const error = await runAndCatch(projectDir, sessionId);

    expect(error).toMatchObject({
      exitCode: 1,
      message: 'Workflow failed \u2014 see the error output above.',
    });
    expect(records()).toEqual([
      { type: 'error', message: `Session ${sessionId} ended with status failed.` },
    ]);
  });

  it('a stopped run with no recorded failure does not report a failure', async () => {
    const { projectDir, sessionId } = seedFinishedSession('stopped', { phase: 'implementing' });
    saveSummary(
      { projectDir, sessionId },
      {
        id: sessionId,
        feature: 'finish me',
        startedAt: Date.now(),
        completedAt: null,
        stateVersion: 4,
        status: 'open',
        stop: 'stopped',
        summary: null,
      },
    );

    const error = await runAndCatch(projectDir, sessionId);

    expect(error).toMatchObject({
      exitCode: 1,
      message: 'Workflow did not complete \u2014 the run stopped early.',
    });
    expect(records()).toEqual([
      { type: 'error', message: `Session ${sessionId} ended with status open.` },
    ]);
  });
});
