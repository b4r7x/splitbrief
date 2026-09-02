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
import {
  createBriefRecoveryState,
  createStorageBlockedRecovery,
} from '../engine/orchestrator/planning/brief-recovery.js';
import { HeadlessJsonRecordSchema } from '../engine/events/public-json.js';
import type { HeadlessJsonRecord } from '../engine/events/public-json.js';
import {
  type BriefRecoveryV1,
  RejectedStorageBriefRecoveryV1Schema,
} from '../core/schemas/brief-recovery/document.js';
import { writeActive } from '../core/sessions/active-pointer.js';
import { buildContextOverflowRecoveryIssue } from '../engine/orchestrator/recovery/builders/task.js';
import { runHeadless } from './headless.js';
import { headlessRecoveryOutcome, headlessRecoveryStatus } from './headless-recovery.js';
import type { Implementer } from '../engine/implementers/types.js';
import type { Planner } from '../engine/planners/types.js';

let stderrSpy: ReturnType<typeof vi.spyOn>;
let dirs: string[] = [];

function recoveryInput(sessionId: string, blocked: boolean) {
  const briefHash = 'a'.repeat(64);
  const reportHash = 'b'.repeat(64);
  const issues = blocked
    ? [{ code: 'empty_task_list', severity: 'error' as const, taskId: null, message: 'No tasks' }]
    : [];
  return {
    sessionId,
    origin: { mode: 'standard' as const, entry: 'initial' as const },
    continuation: {
      version: 1 as const,
      kind: 'approval' as const,
      mode: 'standard' as const,
      entry: 'initial' as const,
    },
    activeBrief: { revision: 1, hash: briefHash, path: 'tasks.md' },
    report: {
      briefHash,
      report: { revision: 1, hash: reportHash, path: 'brief-quality.json' },
      ruleVersion: 'brief-quality-v1',
      issues,
      errorCount: issues.length,
    },
    qualityPolicyVersion: 'brief-quality-v1',
  };
}

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

  it.each(['paused', 'applying'] as const)(
    'a run ending with a %s recovery exits 1, emits the record and names the resolution route',
    async (status) => {
      const projectDir = createHeadlessGitProject(`headless-recovery-${status}`);
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
        message: expect.stringContaining(`Recovery required (status: ${status})`),
      });
      expect(error.message).toContain('abort-workflow');

      const jsonLines = stdoutChunks
        .join('')
        .trim()
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as { type?: string; status?: string });
      expect(jsonLines).toContainEqual(
        expect.objectContaining({
          type: 'recovery_required',
          status,
        }),
      );
    },
  );
});

describe('runHeadless — v4 Brief recovery outcomes', () => {
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

  async function runRecovery(
    recovery: BriefRecoveryV1,
    phase: 'idle' | 'reviewing-briefs',
  ): Promise<{ planner: Planner; lines: HeadlessJsonRecord[]; error: unknown }> {
    const projectDir = createHeadlessGitProject(`headless-v4-${recovery.status}`);
    dirs.push(projectDir);
    writeMinimalHeadlessConfigYaml(projectDir);
    const sessionId = `sess-headless-v4-${recovery.status}`;
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });
    const state = {
      ...createInitialState('v4 recovery'),
      phase,
      briefRecovery: recovery,
    };
    saveState({ projectDir, sessionId }, state);
    const planner = makePlanner();
    const implementer = makeImplementer();
    const error = await runHeadless({
      prepared: preparedHeadlessExecution({
        projectDir,
        sessionId,
        feature: 'v4 recovery',
        resumeState: state,
      }),
      _planner: planner,
      _implementer: implementer,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    const lines = stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => HeadlessJsonRecordSchema.parse(JSON.parse(line)));
    return { planner, lines, error };
  }

  it.each([
    ['blocked', true, 'reviewing-briefs'] as const,
    ['readiness-blocked', false, 'reviewing-briefs'] as const,
    ['ready', false, 'reviewing-briefs'] as const,
  ])('reports a %s v4 projection without invoking the planner', async (status, blocked, phase) => {
    const admitted = createBriefRecoveryState(recoveryInput(`status-${status}`, blocked), {
      status: status === 'readiness-blocked' ? 'ready' : status,
    });
    const recovery =
      status === 'readiness-blocked'
        ? ({ ...admitted, status } satisfies BriefRecoveryV1)
        : admitted;
    const { planner, lines, error } = await runRecovery(recovery, phase);
    if (status === 'ready') {
      expect(error).toBeUndefined();
    } else {
      expect(error).toMatchObject({ exitCode: 1 });
    }
    expect(planner.quickPlan).not.toHaveBeenCalled();
    expect(planner.plan).not.toHaveBeenCalled();
    expect(planner.review).not.toHaveBeenCalled();
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'brief_recovery' }),
        expect.objectContaining({ type: 'brief_recovery_result' }),
      ]),
    );
  });

  it('preserves readiness-blocked as a distinct non-zero machine-readable outcome', async () => {
    const recovery = {
      ...createBriefRecoveryState(recoveryInput('readiness-blocked', false)),
      status: 'readiness-blocked',
    } satisfies BriefRecoveryV1;
    const { lines, error } = await runRecovery(recovery, 'reviewing-briefs');

    expect(error).toMatchObject({ exitCode: 1 });
    const projectionRecord = lines.find(
      (line): line is Extract<HeadlessJsonRecord, { type: 'brief_recovery' }> =>
        line.type === 'brief_recovery',
    );
    const resultRecord = lines.find(
      (line): line is Extract<HeadlessJsonRecord, { type: 'brief_recovery_result' }> =>
        line.type === 'brief_recovery_result',
    );

    expect(projectionRecord?.projection.status).toBe('readiness-blocked');
    if (projectionRecord?.type === 'brief_recovery') {
      expect(headlessRecoveryStatus(projectionRecord.projection)).toBe('readiness-blocked');
      expect(headlessRecoveryOutcome(projectionRecord.projection)).toEqual({
        status: 'readiness-blocked',
        exitCode: 1,
      });
    }
    expect(resultRecord?.result).toMatchObject({
      kind: 'blocked',
      code: 'brief_readiness_blocked',
    });
  });

  it('reports storage-blocked and rejected recovery without a provider call', async () => {
    const input = recoveryInput('storage', false);
    const storage = createStorageBlockedRecovery(input, {
      code: 'brief_storage_invalid',
      artifactRef: 'tasks.md',
    });
    const storageRun = await runRecovery(storage, 'reviewing-briefs');
    expect(storageRun.planner.isAvailable).not.toHaveBeenCalled();
    const storageRecord = storageRun.lines.find(
      (line): line is Extract<HeadlessJsonRecord, { type: 'brief_recovery' }> =>
        line.type === 'brief_recovery',
    );
    expect(storageRecord?.projection.status).toBe('storage-blocked');
    expect(storageRun.error).toMatchObject({ exitCode: 1 });

    const rejected = RejectedStorageBriefRecoveryV1Schema.parse({
      ...storage,
      status: 'rejected',
    });
    const rejectedRun = await runRecovery(rejected, 'idle');
    expect(rejectedRun.planner.isAvailable).not.toHaveBeenCalled();
    const rejectedRecord = rejectedRun.lines.findLast(
      (line): line is Extract<HeadlessJsonRecord, { type: 'brief_recovery' }> =>
        line.type === 'brief_recovery',
    );
    expect(rejectedRecord?.projection.status).toBe('rejected');
    expect(rejectedRun.error).toMatchObject({ exitCode: 1 });
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
        issue: {
          ...buildContextOverflowRecoveryIssue({
            task,
            phase: 'implementing',
            createdAt: '2026-04-28T12:00:00.000Z',
          }),
          status: 'paused',
        },
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
    expect(prepared.config.workflow.taskReview).toBe('none');

    await expect(
      runHeadless({
        prepared,
        _planner: makePlanner(),
        _implementer: makeImplementer(),
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('Recovery required') });

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
      '  mode: quick',
      '  task_review: none',
      '  persist_transcript: true',
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
      quickPlan: vi.fn().mockResolvedValue({
        spec: '',
        plan: '',
        tasks: [
          makeTask({
            scope: { inBounds: ['src/hello.ts'], outOfBounds: ['everything else'] },
            evidence: ['src/hello.test.ts passes'],
            typeDefs: 'export type Hello = string;',
          }),
        ],
        usage: { inputTokens: 50, outputTokens: 25 },
      }),
    });

    await runHeadless({ prepared, _planner: planner, _implementer: makeImplementer() });

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
    expect(loadState({ projectDir, sessionId })?.phase).toBe('complete');
  }, 30_000);
});
