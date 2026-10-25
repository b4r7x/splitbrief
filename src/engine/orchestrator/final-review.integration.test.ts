import { plainUserMessage } from '../../core/types/user-input.js';

import { runPlanningPhase } from './planning/run.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { scriptedTypedCall } from '#testing/helpers/typed-planner.js';
import { TEST_METADATA, TEST_SINKS } from '#testing/helpers/orchestrator-factories.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makeCallbacks,
  makeCopyingIsolation,
  makeImplementer,
  makePlanner,
  makeBusRecorder,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { persistReadyExecutionState } from '#testing/helpers/persisted-execution.js';
import {
  planFromTasks,
  passingReviewVerdict,
  failedReviewVerdict,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';
import { ensureSessionDir, writeSpecFile } from '../../core/paths-io.js';
import {
  sessionDir,
  REVIEW_FILE,
  REVIEW_JSON_FILE,
  PLAN_FILE,
  SPEC_FILE,
  TASKS_FILE,
  DRIFT_REPORT_FILE,
  REVIEW_PACKET_JSON_FILE,
  REVIEW_PACKET_MARKDOWN_FILE,
  EVIDENCE_FILE,
  SESSION_LOG_FILE,
} from '../../core/paths.js';
import { hashTaskBrief } from '../../core/evidence/brief-hash.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { ReviewRecordSchema } from '../../core/schemas/workflow.js';
import { taskId, type Task } from '../../core/schemas/task.js';
import type { ReviewVerdict } from '../../core/schemas/review.js';
import { finalReviewError, runFinalReviewPhase } from './final-review.js';
import { createContinuationHolder } from './continuation.js';
import { getRunnerCatalogDisplayName } from '../../core/config/accessors/runner-config.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { Summary } from '../../core/schemas/summary.js';
import { ReviewPacketSchema } from '../../core/schemas/review-packet.js';
import { createEvidenceLedger, withUpdatedTask } from '../../core/evidence/ledger-state.js';
import { readEvidenceLedger, writeEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import { appendReviewChanges } from '../../core/evidence/review-changes.js';
import { readConfinedEntry } from './approval/file-snapshots/entry.js';
import { enqueueUserMessage } from './queue/submit.js';
import { isQueuedMessagePendingReviewer } from '../../core/queue-state.js';
import { runTasksAndReview } from './run/task-execution.js';
import { createValidator } from './validation/run.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(files: Record<string, string> = {}): {
  projectDir: string;
  sessionId: string;
  runStartHead: string;
} {
  const projectDir = createTempDir('final-review-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir, files);
  const sessionId = 'sess-final';
  ensureSessionDir(projectDir, sessionId);
  const runStartHead = execSync('git rev-parse HEAD', {
    cwd: projectDir,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  return { projectDir, sessionId, runStartHead };
}

function allTasksDoneState(tasks: Task[], runStartHead: string | null): WorkflowState {
  const s = makeImplState(tasks);
  return {
    ...s,
    implementerTool: 'ollama',
    implementerModel: 'qwen2.5',
    changedFilesBaseline: { head: runStartHead, fingerprints: {}, runStartChangedFiles: [] },
  };
}

const SUMMARY_BASE = {
  feature: 'test feature',
  startTime: Date.now() - 1000,
  plannerTool: 'claude-code',
  implementerTool: 'ollama',
};

const REVIEWER_RUNNER = {
  kind: 'api',
  provider: 'custom-endpoint',
  service: 'custom-endpoint',
  offering: 'payg',
  apiBase: 'https://api.example.com/v1',
  apiKey: 'sk-reviewer',
  model: 'deepseek-reviewer',
} as const;

const REVIEWER_IDENTITY = getRunnerCatalogDisplayName(REVIEWER_RUNNER);

function packetStatus(projectDir: string, sessionId: string): string {
  const packetPath = join(sessionDir(projectDir, sessionId), REVIEW_PACKET_JSON_FILE);
  return ReviewPacketSchema.parse(JSON.parse(readFileSync(packetPath, 'utf-8'))).finalReview.status;
}

function readReviewRecord(projectDir: string, sessionId: string) {
  const path = join(sessionDir(projectDir, sessionId), REVIEW_JSON_FILE);
  return ReviewRecordSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
}

/** A review seat that scripts its verdicts and records each prompt it was handed. */
function makeReviewer(
  review: (prompt: string, call: number) => ReviewVerdict = (prompt) =>
    passingReviewVerdict(prompt),
  usage?: Readonly<{ inputTokens: number; outputTokens: number }> | undefined,
): { reviewer: ReturnType<typeof makePlanner>; prompts: string[] } {
  const prompts: string[] = [];
  const reviewer = makePlanner({
    typedCall: typedCallPlanAndReview(
      () => planFromTasks([]),
      (prompt, call) => {
        prompts.push(prompt);
        return review(prompt, call);
      },
      usage === undefined ? undefined : { review: usage },
    ),
  });
  return { reviewer, prompts };
}

// The final review attributes run effects from review-changes.json, never from
// the working tree: a scenario where a task wrote a file must record the
// promotion the way the promotion gate does.
async function recordPromotion({
  projectDir,
  sessionId,
  task,
  path,
}: {
  projectDir: string;
  sessionId: string;
  task: Task;
  path: string;
}): Promise<void> {
  const after = await readConfinedEntry(projectDir, path);
  appendReviewChanges({ projectDir, sessionId }, [
    {
      kind: 'captured',
      taskId: task.id,
      briefHash: hashTaskBrief([task]),
      path,
      before: null,
      after:
        after.kind === 'file'
          ? {
              base64: after.bytes.toString('base64'),
              sha256: after.sha256,
              mode: after.mode,
            }
          : null,
    },
  ]);
}

describe('runFinalReviewPhase continuation', () => {
  it('re-issues the whole review prompt with the note, never a session resume', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nAdd auth.\n', null);
    const { reviewer, prompts } = makeReviewer();
    const { bus } = makeBusRecorder();
    const { callbacks } = makeCallbacks();

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      continuation: createContinuationHolder({
        step: { kind: 'review', cycle: 0 },
        partial: 'I had listed two findings',
        steer: plainUserMessage('ignore the formatting nits'),
      }),
      summaryBase: { ...SUMMARY_BASE, projectDir, sessionId },
    });

    expect(prompts).toHaveLength(1);
    // The spec, the briefs and the diff are all still in the prompt.
    expect(prompts[0]).toContain('Add auth.');
    expect(prompts[0]).toContain('T001');
    expect(prompts[0]).toContain('I had listed two findings');
    expect(prompts[0]).toContain('ignore the formatting nits');
  });

  it('reviews a run planned on one session against its plan document', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan\n\nGreet people by name.\n', null);
    const { reviewer, prompts } = makeReviewer();

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks: makeCallbacks().callbacks,
      bus: makeBusRecorder().bus,
      state: {
        ...allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
        plan: {
          summary: 'Greet people by name.',
          decisions: [],
          criteria: [{ id: 'C1', text: 'A name gets a greeting', checkIds: ['K1'] }],
          checks: [],
          validation: null,
        },
      },
      reviewer,
      metadata: TEST_METADATA,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      summaryBase: { ...SUMMARY_BASE, projectDir, sessionId },
    });

    expect(prompts[0]).toContain('Greet people by name.');
    expect(prompts[0]).toContain('C1: A name gets a greeting (checks: K1)');
    expect(prompts[0]).toContain('Criterion ids: C1');
  });
});

describe('runFinalReviewPhase', () => {
  it('publishes no review events when preReview halts', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    const { bus, events } = makeBusRecorder();
    const { reviewer } = makeReviewer();
    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks: makeCallbacks().callbacks,
      bus,
      state: allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
      reviewer,
      preReview: async (state) => ({ state, kind: 'stopped' }),
    });
    expect(result.preReview).toBe('stopped');
    expect(reviewer.typedCall).not.toHaveBeenCalled();
    expect(
      events.filter(
        (event) => event.type === 'review_started' || event.type === 'review_completed',
      ),
    ).toEqual([]);
  });

  it('tracks the final-review phase before the reviewer is called', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nAdd auth.\n', null);
    let tracked: WorkflowState | undefined;
    let phaseAtReview: WorkflowState['phase'] | undefined;
    const { reviewer } = makeReviewer((prompt) => {
      phaseAtReview = tracked?.phase;
      return passingReviewVerdict(prompt);
    });
    const { bus } = makeBusRecorder();
    const { callbacks } = makeCallbacks();

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      setTrackedState: (state) => {
        tracked = state;
      },
      summaryBase: { ...SUMMARY_BASE, projectDir, sessionId },
    });

    expect(phaseAtReview).toBe('final-review');
  });

  it('runs the reviewer, writes review.json and the rendered review.md, and returns the outcome', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    // A non-trivial spec so the review prompt is well-formed.
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nAdd auth.\n', null);

    const completions: Summary[] = [];
    const onComplete = (s: Summary) => {
      completions.push(s);
    };
    const { callbacks } = makeCallbacks({ onComplete });
    const { bus, events } = makeBusRecorder();
    const { reviewer } = makeReviewer(
      (prompt, call) =>
        call === 1
          ? failedReviewVerdict(prompt, 'src/alpha.ts drops the error', { taskId: 'T001' })
          : passingReviewVerdict(prompt),
      { inputTokens: 200, outputTokens: 40 },
    );

    const state = allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead);

    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state,
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    expect(result.reviewStatus).toBe('written');
    expect(result.verdict?.outcome.kind).toBe('fail');
    expect(result.verdict?.outcome.blocking).toHaveLength(1);
    expect(result.state.phase).toBe('final-review');
    expect(completions).toEqual([]);

    const reviewPath = join(sessionDir(projectDir, sessionId), REVIEW_FILE);
    expect(existsSync(reviewPath)).toBe(true);
    const markdown = readFileSync(reviewPath, 'utf-8');
    expect(markdown).toContain('### Verdict\n\nfail');
    expect(markdown).toContain('src/alpha.ts drops the error');

    // The typed record is the verdict's one home: review.json and state.review.
    const record = readReviewRecord(projectDir, sessionId);
    expect(record.outcome).toBe('fail');
    expect(record.verdict.tasks).toEqual([{ id: taskId('T001'), plan: 'met', note: '' }]);
    expect(record.cycle).toBe(0);
    expect(result.state.review).toEqual(record);

    expect(events.filter((event) => event.type === 'review_started')).toEqual([
      expect.objectContaining({ scope: 'final', tool: 'claude-code' }),
    ]);
    const completionsEvents = events.filter((event) => event.type === 'review_completed');
    expect(completionsEvents).toEqual([
      expect.objectContaining({
        scope: 'final',
        tool: 'claude-code',
        verdict: 'fail',
        findings: { blocking: 1, minor: 0, outOfScope: 0 },
      }),
    ]);
    expect(completionsEvents[0]?.duration).toBeGreaterThanOrEqual(0);
    expect(completionsEvents[0]).not.toHaveProperty('afterTaskId');
    expect(completionsEvents[0]).not.toHaveProperty('axes');
    expect(events.filter((event) => event.type === 'planner_status')).toEqual([]);

    const packetPath = join(sessionDir(projectDir, sessionId), REVIEW_PACKET_JSON_FILE);
    expect(existsSync(packetPath)).toBe(true);
    const packet = ReviewPacketSchema.parse(JSON.parse(readFileSync(packetPath, 'utf-8')));
    expect(packet.finalReview.status).toBe('written');
    expect(packet.finalReview.verdict).toBe('fail');
    expect(existsSync(join(sessionDir(projectDir, sessionId), REVIEW_PACKET_MARKDOWN_FILE))).toBe(
      true,
    );
  });

  it('passes a minor-only verdict with notes', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nAdd auth.\n', null);
    const { reviewer } = makeReviewer((prompt) => ({
      ...passingReviewVerdict(prompt),
      findings: [
        {
          id: 'F1',
          kind: 'defect',
          severity: 'minor',
          taskId: 'T001',
          file: 'src/alpha.ts',
          line: 3,
          text: 'the naming is loose',
          acceptance: null,
          checkIds: null,
          criterionId: null,
        },
      ],
    }));

    const { bus, events } = makeBusRecorder();
    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks: makeCallbacks().callbacks,
      bus,
      state: allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    expect(result.reviewStatus).toBe('written');
    expect(result.verdict?.outcome.kind).toBe('pass-with-notes');
    expect(result.verdict?.outcome.minor).toHaveLength(1);
    expect(events.filter((event) => event.type === 'review_completed')).toEqual([
      expect.objectContaining({
        verdict: 'pass-with-notes',
        findings: { blocking: 0, minor: 1, outOfScope: 0 },
      }),
    ]);
    const markdown = readFileSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE), 'utf-8');
    expect(markdown).toContain('### Verdict\n\npass_with_notes');
    expect(readReviewRecord(projectDir, sessionId).outcome).toBe('pass-with-notes');
  });

  it('repairs a verdict missing a task once, then fails the seat', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nAdd auth.\n', null);
    const { bus, events } = makeBusRecorder();
    const state = allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead);
    const { reviewer, prompts } = makeReviewer((prompt, call) => {
      if (call === 1)
        enqueueUserMessage({
          projectDir,
          sessionId,
          state: loadState({ projectDir, sessionId }) ?? state,
          bus,
          phase: 'final-review',
          message: plainUserMessage('Check the missing authentication guard'),
        });
      return { ...passingReviewVerdict(prompt), tasks: [] };
    });

    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks: makeCallbacks().callbacks,
      bus,
      state,
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Task T001 is missing from the verdict.');
    expect(prompts[0]).not.toContain('Check the missing authentication guard');
    expect(prompts[1]).toContain('Check the missing authentication guard');
    expect(result.state.messageQueue.filter(isQueuedMessagePendingReviewer)).toHaveLength(0);
    expect(
      loadState({ projectDir, sessionId })?.messageQueue[0]?.deliveredTo?.reviewer,
    ).toBeDefined();
    expect(events.filter((event) => event.type === 'queue_drained')).toEqual([
      expect.objectContaining({ seat: 'review', count: 1 }),
    ]);
    expect(result.reviewStatus).toBe('failed');
    expect(result.verdict).toBeNull();
    expect(result.failure).toMatchObject({
      kind: 'seat-protocol-error',
      error: { kind: 'seat-protocol-error' },
    });
    expect(existsSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE))).toBe(false);
    expect(existsSync(join(sessionDir(projectDir, sessionId), REVIEW_JSON_FILE))).toBe(false);
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(false);
  });

  it.each([
    {
      name: 'refuses a fix-task test check on a test file the run deleted',
      value: 'src/a.test.mjs',
      files: ['src/a.mjs'],
      refused: true,
    },
    {
      name: 'refuses a fix-task test check on a path with a typo',
      value: 'src/a.tset.mjs',
      files: ['src/a.mjs'],
      refused: true,
    },
    {
      name: 'accepts a fix-task test check on a new test file the fix task lists',
      value: 'src/new.test.mjs',
      files: ['src/a.mjs', 'src/new.test.mjs'],
      refused: false,
    },
  ])('$name', async ({ value, files, refused }) => {
    const { projectDir, sessionId, runStartHead } = setupProject({
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      'src/a.mjs': 'export const a = 1;\n',
      'src/a.test.mjs': '',
    });
    rmSync(join(projectDir, 'src/a.test.mjs'));
    const refusal = `Check FC1 is refused: a \`test\` check names one test file, and \`${value}\` is no test file in the workspace, and no task lists it. Set its value to an existing test file, or list the new test file in a task's files.`;
    const state = allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead);
    const { reviewer, prompts } = makeReviewer((prompt) => {
      const failed = failedReviewVerdict(prompt, 'a is wrong');
      return {
        ...failed,
        fixTasks: failed.fixTasks.map((task) => ({
          ...task,
          suggestedFiles: files,
          checks: [{ id: 'FC1', kind: 'test' as const, value, required: true }],
        })),
      };
    });

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig({ validation: { testCommand: undefined } }),
      callbacks: makeCallbacks().callbacks,
      bus: makeBusRecorder().bus,
      state,
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    if (refused) expect(prompts[1]).toContain(refusal);
    else expect(prompts).toHaveLength(1);
  });

  it.each([
    {
      name: 'refuses a fix-task npm run check on a script package.json does not define',
      tasks: [{ files: ['src/a.mjs'], check: { kind: 'cmd' as const, value: 'npm run tset' } }],
      refusal:
        "Check FC1 is refused: `npm run tset` runs the npm script tset, which package.json does not define. Name a script that package.json defines, or list package.json in the task's files and add the script there.",
    },
    {
      name: 'accepts a fix-task npm run check on a script the fix task adds to package.json',
      tasks: [
        {
          files: ['src/a.mjs', 'package.json'],
          check: { kind: 'cmd' as const, value: 'npm run tset' },
        },
      ],
      refusal: null,
    },
    {
      name: 'refuses a fix-task render check when the project sets no render command',
      tasks: [{ files: ['src/a.mjs'], check: { kind: 'render' as const, value: 'workflow-x' } }],
      refusal:
        'Render check FC1 needs validation.render, which is not set; use a check of another kind.',
    },
    {
      name: 'accepts a fix-task test check on a test file an earlier fix task writes',
      tasks: [
        {
          files: ['src/new.test.mjs'],
          check: { kind: 'test' as const, value: 'src/new.test.mjs' },
        },
        { files: ['src/a.mjs'], check: { kind: 'test' as const, value: 'src/new.test.mjs' } },
      ],
      refusal: null,
    },
    {
      name: 'accepts a fix-task test check on a test file a later fix task writes',
      tasks: [
        { files: ['src/a.mjs'], check: { kind: 'test' as const, value: 'src/new.test.mjs' } },
        {
          files: ['src/new.test.mjs'],
          check: { kind: 'test' as const, value: 'src/new.test.mjs' },
        },
      ],
      refusal: null,
    },
  ])('$name', async ({ tasks, refusal }) => {
    const { projectDir, sessionId, runStartHead } = setupProject({
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      'src/a.mjs': 'export const a = 1;\n',
    });
    const state = {
      ...allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
      approve: 'plan' as const,
    };
    const { reviewer, prompts } = makeReviewer((prompt) => {
      const failed = failedReviewVerdict(prompt, 'a is wrong');
      const base = failed.fixTasks[0]!;
      const finding = failed.findings[0]!;
      return {
        ...failed,
        findings: tasks.map((_, index) => ({ ...finding, id: `F${index + 1}` })),
        fixTasks: tasks.map(({ files, check }, index) => ({
          ...base,
          id: `T90${index}`,
          suggestedFiles: files,
          checks: [{ id: `FC${index + 1}`, ...check, required: true }],
          findingIds: [`F${index + 1}`],
        })),
      };
    });

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig({
        validation: { testCommand: undefined },
        workflow: { approve: 'plan' },
      }),
      callbacks: makeCallbacks().callbacks,
      bus: makeBusRecorder().bus,
      state,
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    if (refusal !== null) expect(prompts[1]).toContain(refusal);
    else expect(prompts).toHaveLength(1);
  });

  it('fails the review, never passes it, when the plan call fails', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    const verdicts: string[] = [];
    const checks = vi.fn(() => ({ commands: [], declined: [], reason: null }));
    const reviewer = makePlanner({
      typedCall: typedCallPlanAndReview(
        () => planFromTasks([]),
        (prompt) => {
          verdicts.push(prompt);
          return passingReviewVerdict(prompt);
        },
        undefined,
        checks,
      ),
    });

    const { bus, events } = makeBusRecorder();
    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig({ validation: { endChecks: true } }),
      callbacks: makeCallbacks().callbacks,
      bus,
      state: allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
      reviewChecks: true,
    });

    // The plan names no command and no reason, so the plan call fails its contract.
    expect(verdicts).toEqual([]);
    expect(result.reviewStatus).toBe('failed');
    expect(result.verdict).toBeNull();
    expect(result.failure).toMatchObject({ kind: 'seat-protocol-error' });
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(false);
  });

  it('makes no plan call when the review takes no reviewer checks', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    const checks = vi.fn(() => ({ commands: [], declined: [], reason: 'not asked' }));
    const reviewer = makePlanner({
      typedCall: typedCallPlanAndReview(
        () => planFromTasks([]),
        (prompt) => passingReviewVerdict(prompt),
        undefined,
        checks,
      ),
    });

    const { bus, events } = makeBusRecorder();
    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig({ validation: { endChecks: true } }),
      callbacks: makeCallbacks().callbacks,
      bus,
      state: allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
      reviewChecks: false,
    });

    expect(checks).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'review_checks')).toEqual([]);
    expect(result.reviewStatus).toBe('written');
  });

  it('lets a verify name a reviewer check only while End-of-run checks are on', async () => {
    const verifyV1 = async (endChecks: boolean) => {
      const { projectDir, sessionId, runStartHead } = setupProject();
      const { reviewer, prompts } = makeReviewer((prompt) => ({
        ...passingReviewVerdict(prompt),
        findings: [
          {
            id: 'F1',
            kind: 'defect',
            severity: 'blocking',
            taskId: 'T001',
            file: null,
            line: null,
            text: 'the greeting drops the name',
            acceptance: 'The greeting names the person',
            checkIds: null,
            criterionId: null,
          },
        ],
        verify: [{ findingId: 'F1', checkIds: ['V1'] }],
      }));
      const result = await runFinalReviewPhase({
        projectDir,
        workspaceDir: projectDir,
        sessionId,
        config: makeNoValidationConfig({ validation: { endChecks } }),
        callbacks: makeCallbacks().callbacks,
        bus: makeBusRecorder().bus,
        state: {
          ...allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
          reviewChecks: {
            scope: 'final',
            cycle: 0,
            plan: {
              commands: [{ id: 'V1', command: 'node --version', reason: 'the runtime answers' }],
              declined: [],
              reason: null,
            },
            at: '2026-10-08T00:00:00.000Z',
          },
        },
        reviewer,
        metadata: TEST_METADATA,
        summaryBase: SUMMARY_BASE,
        reviewChecks: false,
      });
      return { result, prompts: prompts.join('\n') };
    };

    const on = await verifyV1(true);
    expect(on.prompts).not.toContain('names unknown check V1');
    expect(on.result.failure).toBeUndefined();

    const off = await verifyV1(false);
    expect(off.prompts).toContain('Verify for F1 names unknown check V1.');
    expect(off.result.failure).toMatchObject({ kind: 'seat-protocol-error' });
  });

  it('uses the repaired verdict when the one repair completes the coverage', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nAdd auth.\n', null);
    const { reviewer, prompts } = makeReviewer((prompt, call) =>
      call === 1 ? { ...passingReviewVerdict(prompt), tasks: [] } : passingReviewVerdict(prompt),
    );

    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks: makeCallbacks().callbacks,
      bus: makeBusRecorder().bus,
      state: allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    expect(prompts).toHaveLength(2);
    expect(result.reviewStatus).toBe('written');
    expect(result.verdict?.outcome.kind).toBe('pass');
  });

  it('records no triage cycle for a passing review with empty fix work', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    const { reviewer } = makeReviewer();
    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks: makeCallbacks().callbacks,
      bus: makeBusRecorder().bus,
      state: allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
      reviewer,
    });
    expect(result.verdict?.outcome.kind).toBe('pass');
    expect(result.state.triage ?? []).toEqual([]);
  });

  it('runs no claim check while a new red suite input is pending', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    const { reviewer } = makeReviewer((prompt) => ({
      ...passingReviewVerdict(prompt),
      criteria: [{ id: 'C1', status: 'unverified', evidence: 'The suite stopped.' }],
      rejected: [{ findingId: 'P1', reason: 'No fix proposed' }],
    }));
    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks: makeCallbacks().callbacks,
      bus: makeBusRecorder().bus,
      state: {
        ...allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
        plan: {
          summary: 'Verify the greeting.',
          decisions: [],
          criteria: [{ id: 'C1', text: 'A greeting works', checkIds: ['K1'] }],
          checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
          validation: null,
        },
        pendingTriage: {
          inputs: [
            { id: 'P1', kind: 'defect', source: 'check', file: null, text: 'Typecheck failed' },
          ],
        },
      },
      reviewer,
    });
    expect(result.reviewStatus).toBe('written');
    expect(result.verdict?.outcome.unverifiedCriteria).toEqual(['C1']);
    expect(result.state.review?.verification).toEqual([]);
    expect(
      readEvidenceLedger({ projectDir, sessionId })?.tasks.flatMap((task) => task.checks ?? []) ??
        [],
    ).toEqual([]);
  });

  it('counts an unverified criterion as pass when its current task check passes', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan\n\nGreet people by name.\n', null);
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({ name: 'review-check', version: '1.0.0', scripts: { test: 'echo ok' } }),
    );
    const { reviewer } = makeReviewer((prompt) => ({
      ...passingReviewVerdict(prompt),
      criteria: passingReviewVerdict(prompt).criteria.map((criterion) => ({
        ...criterion,
        status: 'unverified' as const,
      })),
    }));

    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks: makeCallbacks().callbacks,
      bus: makeBusRecorder().bus,
      state: {
        ...allTasksDoneState(
          [
            makeTask({
              id: 'T001',
              status: 'done',
              checks: [{ id: 'K1', kind: 'cmd', value: 'npm test', required: true }],
            }),
          ],
          runStartHead,
        ),
        plan: {
          summary: 'Greet people by name.',
          decisions: [],
          criteria: [{ id: 'C1', text: 'A name gets a greeting', checkIds: ['K1'] }],
          checks: [],
          validation: null,
        },
      },
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    const record = readReviewRecord(projectDir, sessionId);
    expect(record.verification).toEqual([
      { id: 'criterion:C1', status: 'pass', output: expect.stringContaining('K1: pass') },
    ]);
    expect(record.outcome).toBe('pass');
    expect(result.verdict?.outcome.kind).toBe('pass');
  });

  it('keeps a render-checked criterion unverified, and that fails the review', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan\n\nRender the gallery.\n', null);
    const { reviewer } = makeReviewer((prompt) => {
      const base = passingReviewVerdict(prompt);
      return {
        ...base,
        criteria: base.criteria.map((criterion) => ({
          ...criterion,
          status: 'unverified' as const,
        })),
      };
    });

    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks: makeCallbacks().callbacks,
      bus: makeBusRecorder().bus,
      state: {
        ...allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
        plan: {
          summary: 'Render the gallery.',
          decisions: [],
          criteria: [{ id: 'C1', text: 'The gallery renders', checkIds: ['K1'] }],
          checks: [{ id: 'K1', kind: 'render', value: 'gallery/hello', required: false }],
          validation: null,
        },
      },
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    const record = readReviewRecord(projectDir, sessionId);
    expect(record.verification).toEqual([
      {
        id: 'criterion:C1',
        status: 'unverified',
        output: expect.stringContaining('validation.render is not set'),
      },
    ]);
    expect(record.outcome).toBe('fail');
    expect(result.verdict?.outcome.unverifiedCriteria).toEqual(['C1']);
  });

  it('turns an unverified finding with a passing check into a note', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan\n\nGreet people by name.\n', null);
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({ name: 'review-check', version: '1.0.0', scripts: { test: 'echo ok' } }),
    );
    const { reviewer } = makeReviewer((prompt) => ({
      ...passingReviewVerdict(prompt),
      findings: [
        {
          id: 'F1',
          kind: 'unverified',
          severity: 'blocking',
          taskId: null,
          file: null,
          line: null,
          text: 'the greeting path needs a check',
          acceptance: null,
          checkIds: ['K1'],
          criterionId: null,
        },
      ],
    }));

    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks: makeCallbacks().callbacks,
      bus: makeBusRecorder().bus,
      state: {
        ...allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
        plan: {
          summary: 'Greet people by name.',
          decisions: [],
          criteria: [{ id: 'C1', text: 'A name gets a greeting', checkIds: ['K1'] }],
          checks: [{ id: 'K1', kind: 'cmd', value: 'npm test', required: true }],
          validation: null,
        },
      },
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    const record = readReviewRecord(projectDir, sessionId);
    expect(record.verification).toEqual([
      { id: 'finding:F1', status: 'pass', output: expect.stringContaining('K1: pass') },
    ]);
    expect(record.outcome).toBe('pass-with-notes');
    expect(result.verdict?.outcome.minor).toHaveLength(1);
    expect(result.verdict?.outcome.blocking).toHaveLength(0);
  });

  it('verifies a claim on a re-review whose check fails only on what the run base failed too', async () => {
    const key = 'legacy/report.mjs:2:1 AssertionError: legacy total expected 3, received 2';
    const command = 'node legacy/report.mjs';
    const { projectDir, sessionId, runStartHead } = setupProject({
      'legacy/report.mjs': `console.error(${JSON.stringify(key)});\nprocess.exitCode = 1;\n`,
    });
    const finding = {
      id: 'F1',
      kind: 'unverified' as const,
      severity: 'blocking' as const,
      taskId: null,
      file: null,
      line: null,
      text: 'V1 fails only on legacy/report.mjs, which fails at the run base too',
      acceptance: null,
      checkIds: ['V1'],
      criterionId: null,
    };
    const { reviewer } = makeReviewer((prompt) => ({
      ...passingReviewVerdict(prompt),
      findings: [finding],
    }));
    const state = allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead);

    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig({ validation: { endChecks: true } }),
      callbacks: makeCallbacks().callbacks,
      bus: makeBusRecorder().bus,
      state: {
        ...state,
        reviewChecks: {
          scope: 'final',
          cycle: 0,
          plan: {
            commands: [{ id: 'V1', command, reason: 'the project checks its report total' }],
            declined: [],
            reason: null,
          },
          at: '2026-10-08T00:00:00.000Z',
        },
        review: {
          cycle: 0,
          verdict: { tasks: [], criteria: [], findings: [] },
          outcome: 'fail',
          verification: [],
          preExistingChecks: [{ id: 'V1', command, keys: [key] }],
          at: '2026-10-08T00:00:00.000Z',
        },
      },
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
      reviewChecks: false,
    });

    const record = readReviewRecord(projectDir, sessionId);
    expect(record.verification).toEqual([
      {
        id: 'finding:F1',
        status: 'pass',
        output: expect.stringContaining(
          `Pre-existing failures (also red at the run base):\n- ${key}`,
        ),
      },
    ]);
    expect(record.outcome).toBe('pass-with-notes');
    expect(result.verdict?.outcome.blocking).toEqual([]);
    expect(result.verdict?.outcome.minor).toEqual([finding]);
    const logged =
      readEvidenceLedger({ projectDir, sessionId })?.tasks.flatMap((task) => task.checks ?? []) ??
      [];
    expect(logged.find((entry) => entry.id === 'V1')).toMatchObject({
      command,
      exitCode: 1,
      preExisting: [key],
    });
  });

  it('verifies nothing for an unverified finding that names no check and no criterion', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nAdd auth.\n', null);
    const { reviewer, prompts } = makeReviewer((prompt) => ({
      ...passingReviewVerdict(prompt),
      findings: [
        {
          id: 'F1',
          kind: 'unverified',
          severity: 'blocking',
          taskId: null,
          file: null,
          line: null,
          text: 'I could not verify this',
          acceptance: null,
          checkIds: [],
          criterionId: null,
        },
      ],
    }));

    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks: makeCallbacks().callbacks,
      bus: makeBusRecorder().bus,
      state: allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    // The coverage rule sends that finding back once; it never verifies.
    expect(prompts).toHaveLength(2);
    expect(result.reviewStatus).toBe('failed');
  });

  it.each([
    { seat: 'CLI', config: () => makeNoValidationConfig() },
    { seat: 'API', config: () => makeNoValidationConfig({ reviewer: REVIEWER_RUNNER }) },
  ])('feeds the checks log into the $seat review before dispatch', async ({ config }) => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nAdd titleCase.\n', null);

    const task = makeTask({ id: 'T001', status: 'done' });
    const ledger = withUpdatedTask(
      createEvidenceLedger({ sessionId, feature: 'feat', tasks: [task] }),
      task.id,
      (entry) => ({
        ...entry,
        status: 'done',
        checks: [
          {
            id: 'test',
            command: 'npm test',
            exitCode: 0,
            output: 'Test Files  1 passed (1)\n     Tests  4 passed (4)',
            workspaceSnapshotId: 'baseline-candidate',
            ts: '2026-10-06T01:00:00.000Z',
          },
          {
            id: 'typecheck',
            command: 'tsc --noEmit',
            exitCode: 1,
            output: 'BOUNDARY_FAILURE',
            workspaceSnapshotId: 'boundary-candidate',
            ts: '2026-10-06T02:00:00.000Z',
          },
          {
            id: 'K1',
            command: 'npm run required',
            exitCode: 0,
            output: 'REQUIRED_CHECK_PASSED',
            workspaceSnapshotId: 'review-candidate',
            ts: '2026-10-06T03:00:00.000Z',
          },
        ],
      }),
    );
    writeEvidenceLedger({ projectDir, sessionId }, ledger);

    const { reviewer, prompts } = makeReviewer();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();

    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: config(),
      callbacks,
      bus,
      state: allTasksDoneState([task], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    expect(result.reviewStatus).toBe('written');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('## Checks Log');
    expect(prompts[0]).not.toContain('## Recorded Validation Output');
    expect(prompts[0]).toContain('- test T001 (exit 0): npm test');
    expect(prompts[0]).toContain('Tests  4 passed (4)');
    expect(prompts[0]).toContain('snapshot: baseline-candidate');
    expect(prompts[0]).toContain('- typecheck T001 (exit 1): tsc --noEmit');
    expect(prompts[0]).toContain('BOUNDARY_FAILURE');
    expect(prompts[0]).toContain('snapshot: boundary-candidate');
    expect(prompts[0]).toContain('- K1 T001 (exit 0): npm run required');
    expect(prompts[0]).toContain('REQUIRED_CHECK_PASSED');
    expect(prompts[0]).toContain('snapshot: review-candidate');
    expect(prompts[0]).toContain('quote the relevant line verbatim from the Checks Log section');
  });

  it.each([
    { seat: 'CLI', config: () => makeNoValidationConfig() },
    { seat: 'API', config: () => makeNoValidationConfig({ reviewer: REVIEWER_RUNNER }) },
  ])('gives the $seat reviewer every path read outside the workspace', async ({ config }) => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nAdd titleCase.\n', null);
    const task = makeTask({ id: 'T001', status: 'done' });
    writeEvidenceLedger(
      { projectDir, sessionId },
      withUpdatedTask(
        createEvidenceLedger({ sessionId, feature: 'feat', tasks: [task] }),
        task.id,
        (entry) => ({
          ...entry,
          status: 'done',
          checks: [
            { id: 'test', command: 'npm test', exitCode: 0, ts: '2026-10-06T01:00:00.000Z' },
          ],
        }),
      ),
    );
    const outsideRead = 'Task T001 read /etc/hosts (outside) with view_file';
    writeFileSync(
      join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE),
      `${JSON.stringify({
        ts: '2026-10-06T00:30:00.000Z',
        kind: 'event',
        type: 'warning',
        taskId: 'T001',
        phase: 'implementing',
        data: { message: outsideRead, category: 'implementer', code: 'isolation_outside_read' },
      })}\n`,
    );
    const { reviewer, prompts } = makeReviewer();

    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: config(),
      callbacks: makeCallbacks().callbacks,
      bus: makeBusRecorder().bus,
      state: allTasksDoneState([task], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    expect(result.reviewStatus).toBe('written');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`- outside read: ${outsideRead}`);
  });

  it('refuses the API review when the outside-read events cannot be read', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nAdd titleCase.\n', null);
    const task = makeTask({ id: 'T001', status: 'done' });
    writeEvidenceLedger(
      { projectDir, sessionId },
      withUpdatedTask(
        createEvidenceLedger({ sessionId, feature: 'feat', tasks: [task] }),
        task.id,
        (entry) => ({
          ...entry,
          status: 'done',
          checks: [
            { id: 'test', command: 'npm test', exitCode: 0, ts: '2026-10-06T01:00:00.000Z' },
          ],
        }),
      ),
    );
    mkdirSync(join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE));
    const { reviewer, prompts } = makeReviewer();

    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig({ reviewer: REVIEWER_RUNNER }),
      callbacks: makeCallbacks().callbacks,
      bus: makeBusRecorder().bus,
      state: allTasksDoneState([task], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    expect(prompts).toHaveLength(0);
    expect(result.failure?.kind).toBe('insufficient-context');
  });

  describe('a checks log above the prompt cap', () => {
    function writeLargeLedger(projectDir: string, sessionId: string, tasks: Task[]): void {
      const ledger = createEvidenceLedger({ sessionId, feature: 'feat', tasks });
      writeEvidenceLedger(
        { projectDir, sessionId },
        tasks.reduce(
          (current, task, index) =>
            withUpdatedTask(current, task.id, (entry) => ({
              ...entry,
              status: 'done',
              checks: ['typecheck', 'lint', 'test'].map((stage) => ({
                id: stage,
                command: `npm run ${stage}`,
                exitCode: 0,
                output: `${stage} ${task.id} `.repeat(60),
                workspaceSnapshotId: `candidate-${task.id}`,
                ts: new Date(Date.UTC(2026, 9, 6, 0, index)).toISOString(),
              })),
            })),
          ledger,
        ),
      );
    }

    const tasks = Array.from({ length: 35 }, (_, index) =>
      makeTask({ id: `T${String(index + 1).padStart(3, '0')}`, status: 'done' }),
    );

    it('keeps the current candidate checks for a CLI reviewer and names the evidence file', async () => {
      const { projectDir, sessionId, runStartHead } = setupProject();
      writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nAdd titleCase.\n', null);
      writeLargeLedger(projectDir, sessionId, tasks);
      const { reviewer, prompts } = makeReviewer();

      await runFinalReviewPhase({
        projectDir,
        workspaceDir: projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        callbacks: makeCallbacks().callbacks,
        bus: makeBusRecorder().bus,
        state: allTasksDoneState(tasks, runStartHead),
        reviewer,
        metadata: TEST_METADATA,
        summaryBase: SUMMARY_BASE,
      });

      expect(prompts).toHaveLength(1);
      for (const stage of ['typecheck', 'lint', 'test']) {
        expect(prompts[0]).toContain(`- ${stage} T035 (exit 0): npm run ${stage}`);
      }
      expect(prompts[0]).toMatch(/\d+ entries omitted/);
      expect(prompts[0]).toContain(join(sessionDir(projectDir, sessionId), EVIDENCE_FILE));
    });

    it('gives an API reviewer the whole checks log, never a trimmed one', async () => {
      const { projectDir, sessionId, runStartHead } = setupProject();
      writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nAdd titleCase.\n', null);
      writeLargeLedger(projectDir, sessionId, tasks);
      const { reviewer, prompts } = makeReviewer();

      await runFinalReviewPhase({
        projectDir,
        workspaceDir: projectDir,
        sessionId,
        config: makeNoValidationConfig({
          reviewer: { ...REVIEWER_RUNNER, contextLength: 400_000 },
        }),
        callbacks: makeCallbacks().callbacks,
        bus: makeBusRecorder().bus,
        state: allTasksDoneState(tasks, runStartHead),
        reviewer,
        metadata: TEST_METADATA,
        summaryBase: SUMMARY_BASE,
      });

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).not.toContain('entries omitted');
      for (const task of tasks) {
        for (const stage of ['typecheck', 'lint', 'test']) {
          expect(prompts[0]).toContain(`- ${stage} ${task.id} (exit 0): npm run ${stage}`);
        }
      }
    });
  });

  it('carries the plan, diff groups, touched files, check results, consult log and answers into the prompt', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan\n\nGreet people by name.\n', null);
    const tasks = [
      makeTask({
        id: 'T001',
        status: 'done',
        criteria: ['C1'],
        suggestedFiles: ['src/alpha.ts'],
        exclusions: ['docs/**'],
        checkResults: [
          { id: 'K1', status: 'pass' },
          { id: 'K2', status: 'refused' },
        ],
      }),
      makeTask({
        id: 'T002',
        status: 'done',
        criteria: ['C2'],
        suggestedFiles: ['src/beta.ts', 'src/shared.ts'],
      }),
    ];
    const task = tasks[0] as Task;
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/alpha.ts'), 'export const alpha = true;\n');
    await recordPromotion({ projectDir, sessionId, task, path: 'src/alpha.ts' });
    const ledger = withUpdatedTask(
      createEvidenceLedger({ sessionId, feature: 'feat', tasks }),
      task.id,
      (entry) => ({ ...entry, status: 'done', changedFiles: ['src/alpha.ts', 'src/shared.ts'] }),
    );

    const planningCall = scriptedTypedCall([
      {
        kind: 'questions',
        questions: [{ id: 'greeting', text: 'Which greeting?', choices: null, default: 'hi' }],
      },
      planFromTasks(tasks),
    ]);
    const planned = await runPlanningPhase({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        callbacks: makeCallbacks({
          onPlannerReply: async () => plainUserMessage('hello'),
          onApprovalNeeded: async () => ({ approved: true }),
        }).callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner: makePlanner({ typedCall: planningCall.typedCall }),
      state: transition(createInitialState('Greet people'), { type: 'START' }),
      feature: 'Greet people',
    });
    expect(planned.state.pendingPlannerConversation).toBeUndefined();
    writeEvidenceLedger({ projectDir, sessionId }, ledger);
    const { reviewer, prompts } = makeReviewer();
    const reviewState: WorkflowState = {
      ...planned.state,
      ...allTasksDoneState(tasks, runStartHead),
      plan: {
        summary: 'Greet people by name.',
        decisions: [{ text: 'Keep the greeting pure', taskId: null }],
        criteria: [
          { id: 'C1', text: 'A name gets a greeting', checkIds: ['K1'] },
          { id: 'C2', text: 'Empty names are refused', checkIds: [] },
        ],
        checks: [],
        validation: null,
      },
      lineages: {
        T001: {
          consults: 1,
          attempts: 1,
          consultAllowance: 3,
          attemptAllowance: 2,
          staleConsultedRevision: {},
          dispatchedRevision: {},
          consultRecords: [
            {
              reason: 'failed',
              action: 'guidance',
              diagnosis: 'the greeting handled empty names',
              at: '2026-01-01T00:00:00.000Z',
              taskId: taskId('T001'),
              revision: 1,
              answer: {
                answer: {
                  diagnosis: 'the greeting handled empty names',
                  action: 'guidance',
                  instructions: 'guard the empty name',
                  context: null,
                },
              },
            },
          ],
          replacedParents: [],
          notes: [],
        },
      },
      triage: [
        {
          cycle: 1,
          at: '2026-01-02T00:00:00Z',
          reviewAt: '2026-01-01T00:00:00Z',
          inputIds: ['F9'],
          result: {
            fixTasks: [],
            rejected: [],
            verify: [{ findingId: 'F9', checkIds: ['K9'] }],
            ask: null,
          },
          verification: [
            {
              id: 'finding:F9',
              status: 'fail',
              output: 'check K9 did not pass (fail): EXACT triage output',
            },
          ],
        },
      ],
    };
    saveState({ projectDir, sessionId }, reviewState);
    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks: makeCallbacks().callbacks,
      bus: makeBusRecorder().bus,
      state: reviewState,
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    const prompt = prompts[0] ?? '';
    expect(prompt).toContain('## Plan');
    expect(prompt).toContain('C1: A name gets a greeting (checks: K1)');
    expect(prompt).toContain('Keep the greeting pure');
    expect(prompt).toContain('T001');
    expect(prompt).toMatch(/^### \S+ — T001$/m);
    expect(prompt).toContain('## Touched, Not Suggested');
    expect(prompt).toContain('src/shared.ts');
    expect(prompt).toContain('## Touched, Not Suggested\n- T001: src/shared.ts');
    expect(prompt).toContain('## Recorded Check Results');
    expect(prompt).toContain('T001 check K1: pass');
    expect(prompt).toContain('T001 check K2: refused');
    expect(prompt).toContain(
      'A check marked refused, not-runnable or unknown did not run: SPLITBRIEF refused its command or could not start it. It is neither a pass nor a failure, so raise no finding for it.',
    );
    expect(prompt).toContain('## Consult Log');
    expect(prompt).toContain('the greeting handled empty names');
    expect(prompt).toContain('## Planning Answers');
    expect(prompt).toContain('1. Which greeting? (default: hi) → hello');
    expect(prompt).toContain('EXACT triage output');
    expect(prompt).toContain('candidate reviewed at 2026-01-01T00:00:00Z');
    expect(prompt).toContain('Task ids: T001, T002');
    expect(prompt).toContain('Criterion ids: C1, C2');
    expect(prompt).not.toContain('A **Critical** finding must name a defect');
  });

  it('persists the review usage through the continuation loop on the sinks path', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);

    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const { reviewer } = makeReviewer(undefined, { inputTokens: 200, outputTokens: 40 });

    const { state } = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      summaryBase: SUMMARY_BASE,
    });

    expect(state.tokenUsage.reviewerInput).toBe(200);
    expect(state.tokenUsage.reviewerOutput).toBe(40);
    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.phase).toBe('final-review');
    expect(persisted?.tokenUsage.reviewerInput).toBe(200);
    expect(persisted?.tokenUsage.reviewerOutput).toBe(40);
  });

  it('reviews the task brief packet, falling back to current state tasks when tasks.md is missing', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nSparse spec.\n', null);
    writeSpecFile(
      { projectDir, sessionId },
      TASKS_FILE,
      [
        '# Task Briefs',
        '',
        'Persisted-only acceptance marker: verify password pepper migration.',
      ].join('\n'),
      null,
    );

    const { reviewer, prompts } = makeReviewer();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const task = makeTask({
      id: 'T001',
      title: 'State fallback task title',
      description: 'State fallback marker: rotate audit log checksum.',
      status: 'done',
    });

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState([task], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    expect(prompts[0]).toContain(
      'Persisted-only acceptance marker: verify password pepper migration.',
    );

    const {
      projectDir: fallbackProjectDir,
      sessionId: fallbackSessionId,
      runStartHead: fallbackRunStartHead,
    } = setupProject();
    writeSpecFile(
      { projectDir: fallbackProjectDir, sessionId: fallbackSessionId },
      SPEC_FILE,
      '',
      null,
    );

    await runFinalReviewPhase({
      projectDir: fallbackProjectDir,
      workspaceDir: fallbackProjectDir,
      sessionId: fallbackSessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState([task], fallbackRunStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    expect(prompts[1]).toContain('State fallback marker: rotate audit log checksum.');
  });

  it('does not complete the workflow when the reviewer throws', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);

    const completions: Summary[] = [];
    const onComplete = (s: Summary) => {
      completions.push(s);
    };
    const { callbacks } = makeCallbacks({ onComplete });
    const { bus, events } = makeBusRecorder();
    const reviewer = makePlanner({
      typedCall: typedCallPlanAndReview(
        () => planFromTasks([]),
        () => {
          throw new Error('reviewer crashed');
        },
      ),
    });

    const state = allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead);

    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state,
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    const message = errorEvent && 'message' in errorEvent ? errorEvent.message : '';
    expect(message.length).toBeGreaterThan(0);

    const reviewPath = join(sessionDir(projectDir, sessionId), REVIEW_FILE);
    expect(existsSync(reviewPath)).toBe(false);

    expect(completions).toEqual([]);
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(false);
    expect(loadState({ projectDir, sessionId })?.phase).toBe('final-review');
    expect(result.reviewStatus).toBe('failed');
    const packetPath = join(sessionDir(projectDir, sessionId), REVIEW_PACKET_JSON_FILE);
    expect(existsSync(packetPath)).toBe(true);
    const packet = ReviewPacketSchema.parse(JSON.parse(readFileSync(packetPath, 'utf-8')));
    expect(packet.finalReview.status).toBe('failed');
  });

  it('reports a failing reviewer without falling back to the planner', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);
    const task = makeTask({ id: 'T001', status: 'done' });
    writeEvidenceLedger(
      { projectDir, sessionId },
      createEvidenceLedger({ sessionId, feature: 'feat', tasks: [task] }),
    );

    const typedCall = typedCallPlanAndReview(
      () => planFromTasks([]),
      () => {
        throw new Error('reviewer unreachable');
      },
    );
    const reviewer = makePlanner({ typedCall });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState([task], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    expect(typedCall).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === 'review_started')).toHaveLength(1);
    const completions = events.filter((event) => event.type === 'review_completed');
    expect(completions).toEqual([
      expect.objectContaining({ scope: 'final', verdict: 'no-verdict' }),
    ]);
    expect(completions[0]).not.toHaveProperty('findings');
    expect(completions[0]?.duration).toBeGreaterThanOrEqual(0);
    expect(packetStatus(projectDir, sessionId)).toBe('failed');
    expect(readEvidenceLedger({ projectDir, sessionId })?.finalReview?.status).toBe('failed');
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(false);
    const failure = events.find((event) => event.type === 'error');
    expect(failure?.message).not.toContain(REVIEWER_IDENTITY);
  });

  it('names the configured reviewer seat in the failure it publishes', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);
    const task = makeTask({ id: 'T001', status: 'done' });
    writeEvidenceLedger(
      { projectDir, sessionId },
      createEvidenceLedger({ sessionId, feature: 'feat', tasks: [task] }),
    );

    const { reviewer } = makeReviewer(() => {
      throw new Error('reviewer unreachable');
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig({ reviewer: REVIEWER_RUNNER }),
      callbacks,
      bus,
      state: allTasksDoneState([task], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    const failure = events.find((event) => event.type === 'error');
    expect(failure?.message).toContain(REVIEWER_IDENTITY);
  });

  it('names the review seat on its start and completion events', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const { reviewer } = makeReviewer(undefined, { inputTokens: 1, outputTokens: 1 });
    const state = {
      ...allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
      plannerTool: 'claude-code',
      plannerModel: 'claude-opus-5-5',
    };

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig({
        reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-6-astra', effort: 'high' },
      }),
      callbacks,
      bus,
      state,
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    const reviews = events.filter(
      (event) => event.type === 'review_started' || event.type === 'review_completed',
    );
    expect(reviews.map((event) => event.type)).toEqual(['review_started', 'review_completed']);
    for (const review of reviews) {
      expect(review).toMatchObject({
        scope: 'final',
        tool: 'codex',
        model: 'gpt-6-astra',
        axes: ['high'],
      });
      expect(review).not.toHaveProperty('afterTaskId');
    }
    expect(events.filter((event) => event.type === 'planner_status')).toEqual([]);
  });

  it('does not emit workflow completion when final review is aborted', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);

    const controller = new AbortController();
    const completions: Summary[] = [];
    const { callbacks } = makeCallbacks({
      onComplete: (summary) => {
        completions.push(summary);
      },
    });
    const { bus, events } = makeBusRecorder();
    const reviewer = makePlanner({
      typedCall: typedCallPlanAndReview(
        () => planFromTasks([]),
        () => {
          controller.abort(new DOMException('The user aborted a request.', 'AbortError'));
          throw new DOMException('The user aborted a request.', 'AbortError');
        },
      ),
    });

    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      signal: controller.signal,
      summaryBase: SUMMARY_BASE,
    });

    expect(result.reviewStatus).toBe('failed');
    expect(completions).toEqual([]);
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(false);
    expect(events.filter((event) => event.type === 'review_started')).toHaveLength(1);
    const reviewCompletions = events.filter((event) => event.type === 'review_completed');
    expect(reviewCompletions).toEqual([
      expect.objectContaining({ scope: 'final', verdict: 'stopped' }),
    ]);
    expect(reviewCompletions[0]).not.toHaveProperty('findings');
    expect(reviewCompletions[0]?.duration).toBeGreaterThanOrEqual(0);
    expect(existsSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE))).toBe(false);
  });

  it('works without the metadata argument', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);

    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const { reviewer } = makeReviewer();
    const state = allTasksDoneState([], runStartHead);

    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state,
      reviewer,
      summaryBase: SUMMARY_BASE,
    });

    expect(result.state.tasks).toEqual([]);
    expect(result.reviewStatus).toBe('written');
    expect(result.verdict?.outcome.kind).toBe('pass');
  });

  it('writes active briefHash into the drift report artifact', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const { reviewer } = makeReviewer();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/hello.ts'], status: 'done' });
    const tasks = [task];

    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/hello.ts'), 'export const hello = () => "hi";\n');
    // The task's target carries a recorded promotion, so the drift universe
    // covers it and no missing_expected_file fires.
    await recordPromotion({ projectDir, sessionId, task, path: 'src/hello.ts' });

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState(tasks, runStartHead),
      reviewer,
      summaryBase: SUMMARY_BASE,
    });

    const drift = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), DRIFT_REPORT_FILE), 'utf8'),
    );
    expect(drift.briefHash).toBe(hashTaskBrief(tasks));
    expect(drift.changedFiles).toContain('src/hello.ts');
    expect(drift.findings).toEqual([]);
  });

  it('names every file of a two-file brief that changed none of them', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const { reviewer, prompts } = makeReviewer();
    const task = makeTask({
      id: 'T001',
      suggestedFiles: ['src/a.ts', 'src/b.ts'],
      status: 'done',
    });
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/other.ts'), 'export const other = true;\n');
    await recordPromotion({ projectDir, sessionId, task, path: 'src/other.ts' });

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState([task], runStartHead),
      reviewer,
      summaryBase: SUMMARY_BASE,
    });

    const message = 'Task T001 reached done but src/a.ts, src/b.ts were not changed.';
    const drift = events.find((event) => event.type === 'drift_report');
    expect(drift?.type === 'drift_report' ? drift.findings : []).toContainEqual(
      expect.objectContaining({ code: 'missing_expected_file', taskId: 'T001', message }),
    );
    expect(prompts.join('\n')).toContain(message);
  });

  it('fails the review instead of guessing the run boundary when state has no run-start baseline', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/feature.ts'), 'export const feature = true;\n');

    const task = makeTask({ id: 'T001', suggestedFiles: ['src/feature.ts'], status: 'done' });
    const { changedFilesBaseline: _dropped, ...state } = allTasksDoneState([task], runStartHead);
    const completions: Summary[] = [];
    const { callbacks } = makeCallbacks({
      onComplete: (s: Summary) => {
        completions.push(s);
      },
    });
    const { bus, events } = makeBusRecorder();
    const { reviewer, prompts } = makeReviewer();

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state,
      reviewer,
      summaryBase: SUMMARY_BASE,
    });

    const errorEvent = events.find((event) => event.type === 'error');
    const message = errorEvent && 'message' in errorEvent ? errorEvent.message : '';
    expect(message).toContain(finalReviewError.missingRunBaseline().message);
    expect(prompts).toHaveLength(0);
    expect(existsSync(join(sessionDir(projectDir, sessionId), DRIFT_REPORT_FILE))).toBe(false);
    expect(existsSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE))).toBe(false);
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(false);
    expect(completions).toEqual([]);
    expect(loadState({ projectDir, sessionId })?.phase).toBe('final-review');
    expect(packetStatus(projectDir, sessionId)).toBe('failed');
  });

  it('records a rolling-only unplanned path absent at run start as touched, not suggested', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/feature.ts'), 'export const feature = true;\n');
    writeFileSync(join(projectDir, 'src/hook-output.ts'), 'export const hookOutput = true;\n');

    const task = makeTask({
      id: 'T001',
      suggestedFiles: ['src/feature.ts'],
      status: 'done',
      scope: { outOfBounds: ['docs/**'] },
    });
    // Both worker effects carry recorded promotions, so they reach the drift
    // universe; the out-of-scope one is what the report must fail on.
    await recordPromotion({ projectDir, sessionId, task, path: 'src/feature.ts' });
    await recordPromotion({ projectDir, sessionId, task, path: 'src/hook-output.ts' });
    const ledger = withUpdatedTask(
      createEvidenceLedger({ sessionId, feature: 'feat', tasks: [task] }),
      task.id,
      (entry) => ({ ...entry, changedFiles: [task.suggestedFiles[0]] }),
    );
    writeEvidenceLedger({ projectDir, sessionId }, ledger);
    const state: WorkflowState = {
      ...allTasksDoneState([task], runStartHead),
      changedFilesBaseline: {
        head: null,
        fingerprints: {
          'src/feature.ts': 'feature-hash',
          'src/hook-output.ts': 'hook-output-hash',
        },
        runStartChangedFiles: [],
      },
    };
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const { reviewer } = makeReviewer();

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state,
      reviewer,
      summaryBase: SUMMARY_BASE,
    });

    const drift = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), DRIFT_REPORT_FILE), 'utf8'),
    );
    expect(
      drift.findings.find((finding: { file?: string }) => finding.file === 'src/hook-output.ts'),
    ).toMatchObject({
      code: 'out_of_scope_file',
      severity: 'info',
    });
    expect(drift.passed).toBe(true);
  });

  it('includes untracked created-file content in the review prompt diff', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);

    mkdirSync(join(projectDir, 'src'), { recursive: true });
    const marker = 'UNTRACKED_REVIEW_MARKER_42';
    writeFileSync(join(projectDir, 'src/hello.ts'), `export const x = "${marker}";\n`);

    const { reviewer, prompts } = makeReviewer();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/hello.ts'], status: 'done' })];

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState(tasks, runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    expect(prompts[0]).toContain(marker);
  });

  it('derives the review diff and drift universe from recorded promotions when the tree is clean', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);

    // Per-task commit strategy: the implemented file is committed (with the
    // run-authored message prefix) and the working tree is left clean — so a
    // raw `git status` / `git diff` universe is empty. The review diff and
    // drift universe come from the recorded promotion instead, and no false
    // missing_expected_file warning fires.
    const committedMarker = 'COMMITTED_REVIEW_MARKER_77';
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/feature.ts'), `export const y = "${committedMarker}";\n`);
    execSync('git add src/feature.ts', { cwd: projectDir, stdio: 'pipe' });
    execSync('git commit -m "feat(splitbrief): T001 - add feature"', {
      cwd: projectDir,
      stdio: 'pipe',
    });

    const { reviewer, prompts } = makeReviewer();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/feature.ts'], status: 'done' });
    const tasks = [task];

    await recordPromotion({ projectDir, sessionId, task, path: 'src/feature.ts' });

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState(tasks, runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
    });

    expect(prompts[0]).toContain(committedMarker);
    expect(prompts[0]).toMatch(/^### \S+ — T001$/m);

    const drift = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), DRIFT_REPORT_FILE), 'utf8'),
    );
    expect(drift.changedFiles).toContain('src/feature.ts');
    expect(drift.findings.some((f: { code: string }) => f.code === 'missing_expected_file')).toBe(
      false,
    );
    expect(drift.findings).toEqual([]);
  });

  it('uses captured run-start provenance regardless of commit subjects', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);
    mkdirSync(join(projectDir, 'src'), { recursive: true });

    const preRunMarker = 'PRE_RUN_MISLEADING_SUBJECT_MARKER';
    writeFileSync(join(projectDir, 'src/pre-run.ts'), `export const value = "${preRunMarker}";\n`);
    execSync('git add src/pre-run.ts', { cwd: projectDir, stdio: 'pipe' });
    execSync('git commit -m "feat(splitbrief): misleading pre-run subject"', {
      cwd: projectDir,
      stdio: 'pipe',
    });
    const runStartHead = execSync('git rev-parse HEAD', {
      cwd: projectDir,
      encoding: 'utf8',
    }).trim();

    const postRunMarker = 'POST_RUN_ARBITRARY_SUBJECT_MARKER';
    writeFileSync(
      join(projectDir, 'src/post-run.ts'),
      `export const value = "${postRunMarker}";\n`,
    );
    execSync('git add src/post-run.ts', { cwd: projectDir, stdio: 'pipe' });
    execSync('git commit -m "chore: arbitrary post-run subject"', {
      cwd: projectDir,
      stdio: 'pipe',
    });

    const { reviewer, prompts } = makeReviewer();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/post-run.ts'], status: 'done' });
    await recordPromotion({ projectDir, sessionId, task, path: 'src/post-run.ts' });
    const state: WorkflowState = {
      ...allTasksDoneState([task], runStartHead),
      changedFilesBaseline: {
        head: runStartHead,
        fingerprints: {},
        runStartChangedFiles: [],
      },
    };

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state,
      reviewer,
      summaryBase: SUMMARY_BASE,
    });

    expect(prompts[0]).toContain(postRunMarker);
    expect(prompts[0]).not.toContain(preRunMarker);
    const drift = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), DRIFT_REPORT_FILE), 'utf8'),
    );
    expect(drift.changedFiles).toEqual(['src/post-run.ts']);
  });

  it('treats captured null as an unborn run boundary after commits appear', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    const marker = 'CAPTURED_NULL_POST_RUN_COMMIT_MARKER';
    writeFileSync(join(projectDir, 'src/from-unborn.ts'), `export const value = "${marker}";\n`);
    execSync('git add src/from-unborn.ts', { cwd: projectDir, stdio: 'pipe' });
    execSync('git commit -m "docs: subject is irrelevant"', {
      cwd: projectDir,
      stdio: 'pipe',
    });

    const { reviewer, prompts } = makeReviewer();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/from-unborn.ts'], status: 'done' });
    await recordPromotion({ projectDir, sessionId, task, path: 'src/from-unborn.ts' });

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: {
        ...allTasksDoneState([task], runStartHead),
        changedFilesBaseline: {
          head: null,
          fingerprints: {},
          runStartChangedFiles: [],
        },
      },
      reviewer,
      summaryBase: SUMMARY_BASE,
    });

    expect(prompts[0]).toContain(marker);
    const drift = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), DRIFT_REPORT_FILE), 'utf8'),
    );
    expect(drift.changedFiles).toContain('src/from-unborn.ts');
  });

  it('passes the full diff to the review prompt', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    const prohibitedMarker = 'PROHIBITED_AFTER_PROMPT_BOUNDARY';
    writeFileSync(
      join(projectDir, 'src/large.ts'),
      `${'x'.repeat(101_000)}\n${prohibitedMarker}\n`,
    );

    const { reviewer, prompts } = makeReviewer();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const task = makeTask({
      id: 'T001',
      suggestedFiles: ['src/large.ts'],
      status: 'done',
    });
    await recordPromotion({ projectDir, sessionId, task, path: 'src/large.ts' });

    await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState([task], runStartHead),
      reviewer,
      summaryBase: SUMMARY_BASE,
    });

    const promptDiff = prompts[0]
      ?.split('## Implementation Diff\n')[1]
      ?.split('\n## Workspace Context')[0];
    expect(promptDiff).toContain(prohibitedMarker);
    expect(promptDiff).not.toContain('diff truncated');
  });
});

describe('review record', () => {
  it('counts the fix cycle already spent when it records the review', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);
    const { reviewer } = makeReviewer();

    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks: makeCallbacks().callbacks,
      bus: makeBusRecorder().bus,
      state: {
        ...allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
        fixCycles: { used: 2, allowance: 2, notes: [] },
      },
      reviewer,
      summaryBase: SUMMARY_BASE,
    });

    const record = readReviewRecord(projectDir, sessionId);
    expect(record.cycle).toBe(2);
    expect(result.state.review?.cycle).toBe(2);
  });

  it('runs only the fix brief after a failed review, never a brief the user skipped', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    const ref = { projectDir, sessionId };
    const savedState = transition(
      persistReadyExecutionState(ref, {
        ...allTasksDoneState(
          [
            makeTask({ id: 'T001', status: 'skipped', suggestedFiles: ['src/skipped.ts'] }),
            makeTask({ id: 'T002', status: 'done' }),
          ],
          runStartHead,
        ),
        currentTaskIndex: 2,
      }),
      { type: 'ALL_DONE' },
    );
    saveState(ref, savedState);
    const { reviewer } = makeReviewer((prompt) =>
      failedReviewVerdict(prompt, 'src/alpha.ts is missing'),
    );
    const implementer = makeImplementer();
    const { bus, events } = makeBusRecorder();

    const result = await runTasksAndReview({
      wctx: {
        projectDir,
        workspaceDir: projectDir,
        sessionId,
        isolation: makeCopyingIsolation(ref),
        config: makeNoValidationConfig({ workflow: {} }),
        callbacks: makeCallbacks().callbacks,
        bus,
        planner: reviewer,
        reviewer,
        context: defaultContext,
        implementer,
        createImplementer: vi.fn().mockReturnValue(implementer),
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state: savedState,
      planning: { disposition: 'ready-for-tasks', state: savedState, tasks: savedState.tasks },
      summaryBase: SUMMARY_BASE,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(events.find((event) => event.type === 'review_fix_started')).toMatchObject({
      taskIds: ['T003'],
    });
    const starts = events.flatMap((event) => (event.type === 'task_started' ? [event.taskId] : []));
    expect(starts).toEqual(['T003']);
    expect(result.state.tasks.map((task) => [task.id, task.status])).toEqual([
      ['T001', 'skipped'],
      ['T002', 'done'],
      ['T003', 'done'],
    ]);
  }, 90_000);

  it('passes over a brief the user skipped after the brief it runs', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    const ref = { projectDir, sessionId };
    const savedState = persistReadyExecutionState(
      ref,
      allTasksDoneState(
        [makeTask({ id: 'T001' }), makeTask({ id: 'T002', status: 'skipped' })],
        runStartHead,
      ),
    );
    const { reviewer } = makeReviewer();
    const implementer = makeImplementer();
    const { bus, events } = makeBusRecorder();

    const result = await runTasksAndReview({
      wctx: {
        projectDir,
        workspaceDir: projectDir,
        sessionId,
        isolation: makeCopyingIsolation(ref),
        config: makeNoValidationConfig({ workflow: {} }),
        callbacks: makeCallbacks().callbacks,
        bus,
        planner: reviewer,
        reviewer,
        context: defaultContext,
        implementer,
        createImplementer: vi.fn().mockReturnValue(implementer),
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state: savedState,
      planning: { disposition: 'ready-for-tasks', state: savedState, tasks: savedState.tasks },
      summaryBase: SUMMARY_BASE,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const starts = events.flatMap((event) => (event.type === 'task_started' ? [event.taskId] : []));
    expect(starts).toEqual(['T001']);
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'skipped']);
  }, 90_000);
});
