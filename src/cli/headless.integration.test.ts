import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { settleTrackedWorkflows } from '#testing/helpers/tracked-workflow.js';
import {
  createHeadlessGitProject,
  preparedHeadlessExecution,
  writeHeadlessConfigYaml,
  writeMinimalHeadlessConfigYaml,
} from '#testing/helpers/headless-project.js';
import { createInitialState, transition } from '../core/state/machine.js';
import { ensureSessionDir } from '../core/paths-io.js';
import { loadState, saveState } from '../core/state/persistence.js';
import { readConfigDocument } from '../core/config/load/document.js';
import { loadConfig, writeConfig } from '../core/config/load/io.js';
import { HeadlessJsonRecordSchema } from '../engine/events/public-json.js';
import { reactivateExistingSession, writeActive } from '../core/sessions/active-pointer.js';
import {
  buildContextOverflowRecoveryIssue,
  buildSeatDownIssue,
} from '../engine/orchestrator/recovery/builders/task.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { formatResumeCommand } from '../core/recovery/resume-command.js';
import { emitRecoveryAndFailIfPending, runHeadless } from './headless.js';
import { saveSummary } from '../core/sessions/io.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import type { Implementer } from '../engine/implementers/types.js';
import type { Planner } from '../engine/planners/types.js';
import { typedCallFromTasks } from '#testing/helpers/typed-planner.js';
import { readWorkspaceRecord } from '../engine/orchestrator/isolation/retention.js';
import { createRunIsolation } from '../engine/orchestrator/isolation/create.js';
import { createSnapshot } from '../engine/snapshots/create.js';
import { sessionDir } from '../core/paths.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { cliDetectionsFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';

// The two terminal guards read state and session after the run; skipping the run
// itself is what makes them reachable without driving a whole workflow.
const skipTheRun: { enabled: boolean } = { enabled: false };
vi.mock('../engine/orchestrator/run/workflow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/orchestrator/run/workflow.js')>();
  const { trackWorkflow } = await import('#testing/helpers/tracked-workflow.js');
  return {
    ...actual,
    runWorkflow: async (opts: Parameters<typeof actual.runWorkflow>[0]) =>
      skipTheRun.enabled ? undefined : trackWorkflow(actual.runWorkflow, opts),
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

  afterEach(async () => {
    await settleTrackedWorkflows();
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

  afterEach(async () => {
    await settleTrackedWorkflows();
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
      '  end_checks: false',
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

  afterEach(async () => {
    await settleTrackedWorkflows();
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

describe('runHeadless — the seat-down policy and the record', () => {
  let stdoutChunks: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutChunks = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    skipTheRun.enabled = true;
  });

  afterEach(async () => {
    await settleTrackedWorkflows();
    skipTheRun.enabled = false;
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    vi.clearAllMocks();
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  function records() {
    return stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => HeadlessJsonRecordSchema.parse(JSON.parse(line)));
  }

  async function retainedSession(name: string, state: WorkflowState) {
    const projectDir = createHeadlessGitProject(name);
    dirs.push(projectDir);
    const sessionId = `sess-${name}`;
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    writeMinimalHeadlessConfigYaml(projectDir);
    const base = await createSnapshot({ ...ref, phase: 'manual', name: 'workspace-base' });
    const isolation = createRunIsolation({ ...ref, strategy: 'staged-copy', onFallback: () => {} });
    const workspace = await isolation.acquire({ role: 'implementer', config: makeConfig() });
    await workspace.retain?.();
    await isolation.dispose();
    const retained = {
      ...state,
      workspace: {
        kind: 'staged-copy' as const,
        path: workspace.projectDir,
        base: { snapshotId: base.manifest.id, head: workspace.snapshot.head },
      },
    };
    saveState(ref, retained);
    return { ref, state: retained };
  }

  it.each([
    ['malformed', 'halt'],
    ['unreadable', 'halt'],
    ['malformed', 'failure'],
    ['unreadable', 'failure'],
  ] as const)(
    'reports the retained %s record diagnostic and preserves the %s report',
    async (record, outcome) => {
      const { ref, state } = await retainedSession(
        `headless-${record}-${outcome}`,
        makeImplState([], {
          ...(outcome === 'halt' && { pendingRecovery: makeRecoveryIssue() }),
          ...(outcome === 'failure' && {
            lastFailure: {
              message: 'call failed',
              step: { kind: 'review', cycle: 0 },
              at: '2026-10-10T00:00:00.000Z',
            },
          }),
        }),
      );
      const path = join(sessionDir(ref.projectDir, ref.sessionId), 'retained-workspace.json');
      if (record === 'malformed') writeFileSync(path, '{invalid');
      else chmodSync(path, 0o000);
      await expect(readWorkspaceRecord(ref)).rejects.toThrow(
        record === 'malformed' ? 'The stopped workspace could not be verified.' : 'EACCES',
      );
      await expect(
        runHeadless({
          prepared: preparedHeadlessExecution({
            ...ref,
            feature: state.feature,
            resumeState: state,
          }),
        }),
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(records()).toContainEqual(
        expect.objectContaining({
          type: 'event',
          data: expect.objectContaining({
            type: 'error',
            message:
              record === 'malformed'
                ? 'The stopped workspace could not be verified. Its files were left in place; automatic continuation is blocked.'
                : expect.stringContaining('EACCES'),
          }),
        }),
      );
      expect(
        records().filter(
          (record) =>
            record.type === 'event' &&
            record.data.type === 'warning' &&
            record.data.message.startsWith('Workspace kept at '),
        ),
      ).toEqual([]);
      expect(records()).toContainEqual(
        expect.objectContaining({ type: outcome === 'halt' ? 'recovery_required' : 'error' }),
      );
    },
  );

  it.each(['retry-same-worker', 'restore-backup'] as const)(
    'does not publish retention before an answered Apply %s continues',
    async (selectedAction) => {
      skipTheRun.enabled = false;
      const { ref, state } = await retainedSession(
        `headless-answered-${selectedAction}`,
        makeImplState([], {
          phase: 'complete',
          reviewStatus: 'passed',
          pendingRecovery: makeRecoveryIssue({
            reason: 'apply-partial',
            phase: 'complete',
            status: 'applying',
            selectedAction,
            availableActions: ['retry-same-worker', 'restore-backup', 'end-run'],
            recommendedAction: 'retry-same-worker',
          }),
        }),
      );
      const outcome = await runHeadless({
        prepared: preparedHeadlessExecution({ ...ref, feature: state.feature, resumeState: state }),
        _planner: makePlanner(),
      }).then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      expect(outcome.ok).toBe(selectedAction === 'retry-same-worker');
      const emitted = records();
      const resumedAt = emitted.findIndex(
        (record) => record.type === 'event' && record.data.type === 'workflow_resumed',
      );
      expect(resumedAt).toBeGreaterThan(-1);
      const noticesAtEntry = emitted
        .slice(0, resumedAt)
        .flatMap((record) =>
          record.type === 'event' &&
          record.data.type === 'warning' &&
          record.data.message.startsWith('Workspace kept at ')
            ? [record.data.message]
            : [],
        );
      expect(noticesAtEntry).toEqual([]);
      const messages = records().flatMap((record) =>
        record.type === 'event' &&
        record.data.type === 'warning' &&
        record.data.message.startsWith('Workspace kept at ')
          ? [record.data.message]
          : [],
      );
      expect(messages).toEqual(
        selectedAction === 'restore-backup'
          ? [
              `Workspace kept at ${state.workspace.path} for Continue, with its private CLI state and caches.`,
            ]
          : [],
      );
    },
  );

  it('reports an unverifiable retained workspace in plain mode before the halt', async () => {
    const { ref, state } = await retainedSession(
      'headless-plain-invalid-retention',
      makeImplState([], {
        pendingRecovery: makeRecoveryIssue(),
      }),
    );
    writeFileSync(
      join(sessionDir(ref.projectDir, ref.sessionId), 'retained-workspace.json'),
      '{invalid',
    );
    await expect(
      runHeadless({
        prepared: preparedHeadlessExecution({ ...ref, feature: state.feature, resumeState: state }),
        plain: true,
      }),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]).trim())).toContain(
      'The stopped workspace could not be verified. Its files were left in place; automatic continuation is blocked.',
    );
    expect(records()).toEqual([]);
  });

  function seedAutoSwitchSession(name: string) {
    const projectDir = createHeadlessGitProject(name);
    dirs.push(projectDir);
    const sessionId = `sess-${name}`;
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });
    writeConfig(
      projectDir,
      makeConfig({
        implementer: { kind: 'cli', tool: 'opencode', fallback: { tool: 'claude-code' } },
      }),
    );
    const configRevision = readConfigDocument(projectDir).revision?.rawSha256;
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task], {
      pendingRecovery: makeRecoveryIssue({
        reason: 'runner-usage-limit',
        taskId: task.id,
        affectedTaskIds: [task.id],
        availableActions: ['retry-same-worker', 'switch-seat', 'end-run'],
        recommendedAction: 'switch-seat',
        switchSeat: {
          seat: 'build',
          candidates: [{ tool: 'claude-code' }],
          ...(configRevision !== undefined && {
            auto: { candidate: { tool: 'claude-code' }, configRevision },
          }),
        },
      }),
    });
    saveState({ projectDir, sessionId }, state);
    return { projectDir, sessionId, state };
  }

  it('names the halt, cause, provider words, request id, reset and fallback', () => {
    const runner = makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer;
    const issue = buildSeatDownIssue({
      seat: 'build',
      runner,
      classification: { class: 'account', cause: 'balance' },
      words: 'provider.quota: Insufficient Balance',
      requestId: 'req_123',
      resetAt: new Date('2026-04-28T18:00:00.000Z'),
      fallback: { tool: 'claude-code', model: 'sonnet' },
      task: makeTask({ id: 'T001' }),
      phase: 'implementing',
      createdAt: '2026-04-28T12:00:00.000Z',
    });
    const state = {
      ...createInitialState('recover me'),
      phase: 'implementing' as const,
      pendingRecovery: issue,
    };
    const writeRecord = vi.fn();

    expect(() =>
      emitRecoveryAndFailIfPending({ state, sessionId: 'sess-record', writeRecord }),
    ).toThrow(/Seat down/);

    expect(writeRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'recovery_required',
        halt: 'seat-down',
        reason: 'runner-usage-limit',
        cause: 'balance',
        providerMessage: 'provider.quota: Insufficient Balance',
        requestId: 'req_123',
        resetAt: '2026-04-28T18:00:00.000Z',
        fallback: expect.stringContaining('Claude'),
      }),
      process.stdout,
    );
  });

  it.each(['switch', 'halt', 'refused', 'plain-halt'] as const)(
    'automatically switches a retained attempt without publishing a Continue notice',
    async (decision) => {
      skipTheRun.enabled = false;
      const projectDir = createHeadlessGitProject(`headless-retained-${decision}`);
      dirs.push(projectDir);
      const sessionId = `sess-retained-${decision}`;
      const ref = { projectDir, sessionId };
      ensureSessionDir(projectDir, sessionId);
      writeConfig(
        projectDir,
        makeConfig({
          implementer: {
            kind: 'cli',
            tool: 'opencode',
            model: 'deepseek/deepseek-flash',
            fallback: {
              tool: 'opencode',
              model: 'opencode-go/deepseek-v4.1-flash',
              variant: 'high',
            },
          },
          workflow: { isolation: 'staged-copy', approve: 'none' },
          validation: { endChecks: false, testCommand: 'true' },
        }),
      );
      const state = makeImplState([
        makeTask({
          id: 'T001',
          action: 'create',
          suggestedFiles: ['fallback.txt'],
          scope: { inBounds: ['fallback.txt'] },
        }),
      ]);
      saveState(ref, state);
      const prepared = preparedHeadlessExecution({
        ...ref,
        feature: state.feature,
        resumeState: state,
      });
      await rememberDetectedTools(projectDir, cliDetectionsFor('ready', ['opencode']));
      let workspaceDir = '';
      const implementer = makeImplementer({
        implement: vi.fn<Implementer['implement']>(async (input) => {
          workspaceDir = input.projectDir;
          if (input.config.implementer.model === 'deepseek/deepseek-flash') {
            return {
              success: false,
              output: '',
              error: 'provider.quota: Insufficient Balance',
              outcome: 'usage-limit',
            };
          }
          writeFileSync(join(input.projectDir, 'fallback.txt'), 'fallback work\n');
          return { success: true, output: 'done' };
        }),
      });
      const running = runHeadless({
        prepared,
        _planner: makePlanner(),
        _implementer: implementer,
        ...((decision === 'halt' || decision === 'plain-halt') && { onSeatDown: 'halt' }),
        ...(decision === 'plain-halt' && { plain: true }),
        _prepare: async (input) =>
          decision === 'refused'
            ? { kind: 'blocked', report: { ...prepared.report, status: 'blocked' } }
            : {
                kind: 'prepared',
                execution: makePreparedExecution({
                  ...ref,
                  feature: state.feature,
                  config: input.effectiveConfig,
                  resumeState: input.resumeState,
                  active: reactivateExistingSession(ref),
                }),
              },
      });
      if (decision === 'switch') await running;
      else await expect(running).rejects.toMatchObject({ exitCode: 1 });
      expect(workspaceDir).not.toBe('');
      expect(await readWorkspaceRecord(ref)).not.toBeNull();
      const switchEvents = records().flatMap((record) =>
        record.type === 'event' && record.data.type === 'seat_switched' ? [record.data] : [],
      );
      const messages: string[] =
        decision === 'plain-halt'
          ? stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]).trim())
          : records().flatMap((record) =>
              record.type === 'event' && record.data.type === 'warning'
                ? [record.data.message]
                : [],
            );
      if (decision === 'switch') {
        expect(switchEvents).toHaveLength(1);
        expect(switchEvents[0]).toMatchObject({ seat: 'build', auto: true });
        expect(messages.filter((message) => message.startsWith('Workspace kept at '))).toEqual([]);
      } else {
        expect(switchEvents).toHaveLength(0);
        expect(messages.filter((message) => message.startsWith('Workspace kept at '))).toEqual([
          `Workspace kept at ${workspaceDir} for Continue, with its private CLI state and caches.`,
        ]);
      }
    },
  );

  it('applies the declared fallback automatically and records the switch', async () => {
    const { projectDir, sessionId, state } = seedAutoSwitchSession('headless-auto-switch');
    const prepared = preparedHeadlessExecution({
      projectDir,
      sessionId,
      feature: 'recover me',
      resumeState: state,
    });

    await runHeadless({
      prepared,
      _prepare: async (input) => ({
        kind: 'prepared',
        execution: preparedHeadlessExecution({
          projectDir,
          sessionId,
          feature: 'recover me',
          resumeState: input.resumeState,
        }),
      }),
    });

    const switched = records().flatMap((record) =>
      record.type === 'event' && record.data.type === 'seat_switched' ? [record.data] : [],
    );
    expect(switched).toHaveLength(1);
    expect(switched[0]).toMatchObject({ seat: 'build', auto: true, to: { tool: 'claude-code' } });
    expect(loadConfig(projectDir).config.implementer).toMatchObject({ tool: 'claude-code' });
  });

  it('halts on the declared fallback when --on-seat-down is halt', async () => {
    const { projectDir, sessionId, state } = seedAutoSwitchSession('headless-halt');
    const error = await runHeadless({
      prepared: preparedHeadlessExecution({
        projectDir,
        sessionId,
        feature: 'recover me',
        resumeState: state,
      }),
      onSeatDown: 'halt',
    }).then(
      () => {
        throw new Error('runHeadless unexpectedly resolved');
      },
      (err: { exitCode?: number; message?: string }) => err,
    );

    expect(error).toMatchObject({ exitCode: 1, message: expect.stringContaining('Seat down') });
    expect(stdoutChunks.join('')).not.toContain('seat_switched');
    expect(loadConfig(projectDir).config.implementer).toMatchObject({ tool: 'opencode' });
  });

  it('exits 2 when an explicit switch has no fallback to switch to', async () => {
    const projectDir = createHeadlessGitProject('headless-switch-no-fallback');
    dirs.push(projectDir);
    writeMinimalHeadlessConfigYaml(projectDir);
    const sessionId = 'sess-headless-switch-no-fallback';
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });

    const error = await runHeadless({
      prepared: preparedHeadlessExecution({ projectDir, sessionId, feature: 'recover me' }),
      onSeatDown: 'switch',
    }).then(
      () => {
        throw new Error('runHeadless unexpectedly resolved');
      },
      (err: { exitCode?: number; message?: string }) => err,
    );

    expect(error).toMatchObject({ exitCode: 2 });
    expect(error.message).toContain('fallback');
  });
});
