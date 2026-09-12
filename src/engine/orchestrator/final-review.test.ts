import { describe, it, expect, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makeCallbacks,
  makePlanner,
  makeBusRecorder,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { ensureSessionDir, writeSpecFile } from '../../core/paths-io.js';
import {
  sessionDir,
  REVIEW_FILE,
  SPEC_FILE,
  TASKS_FILE,
  DRIFT_REPORT_FILE,
  REVIEW_PACKET_JSON_FILE,
  REVIEW_PACKET_MARKDOWN_FILE,
} from '../../core/paths.js';
import { hashTaskBrief } from '../brief-hash.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { loadState } from '../../core/state/persistence.js';
import { finalReviewError, runFinalReviewPhase } from './final-review.js';
import { getRunnerCatalogDisplayName } from '../../core/config/accessors/runner-config.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import type { Summary } from '../../core/schemas/summary.js';
import { ReviewPacketSchema } from '../../core/schemas/review-packet.js';
import { createEvidenceLedger, withUpdatedTask } from '../../core/evidence/ledger-state.js';
import { readEvidenceLedger, writeEvidenceLedger } from '../../core/evidence/ledger-storage.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string; runStartHead: string } {
  const projectDir = createTempDir('final-review-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
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

const TEST_METADATA = {
  plannerTool: 'claude-code',
  implementerTool: 'ollama',
  mode: 'standard',
} as const;

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

describe('runFinalReviewPhase', () => {
  it('runs the reviewer, writes review.md, emits workflow_complete, transitions to complete', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    // A non-trivial spec so the review prompt is well-formed.
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nAdd auth.\n', null);

    const reviewText = '### Verdict\npass\n\n### Findings\nNone.';
    const reviewPrompts: string[] = [];
    const review = async (prompt: string) => {
      reviewPrompts.push(prompt);
      return { text: reviewText, usage: { inputTokens: 200, outputTokens: 40 } };
    };
    const completions: Summary[] = [];
    const onComplete = (s: Summary) => {
      completions.push(s);
    };
    const { callbacks } = makeCallbacks({ onComplete });
    const { bus, events } = makeBusRecorder();
    const reviewer = makePlanner({ review });

    const state = allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead);
    const phaseTimings: Record<string, number> = {};

    const { summary } = await runFinalReviewPhase({
      projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state,
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
      taskBreakdowns: [] satisfies TaskTokenUsage[],
      phaseTimings,
    });

    expect(reviewPrompts).toHaveLength(1);
    expect(reviewPrompts[0]).toContain('Add auth');

    const reviewPath = join(sessionDir(projectDir, sessionId), REVIEW_FILE);
    expect(existsSync(reviewPath)).toBe(true);
    expect(readFileSync(reviewPath, 'utf-8')).toContain(reviewText);

    expect(completions).toHaveLength(1);
    expect(completions[0]).toBe(summary);

    const statusEvents = events.filter((e) => e.type === 'planner_status');
    expect(statusEvents.length).toBeGreaterThanOrEqual(2);
    expect(statusEvents[0]).toMatchObject({ status: 'running' });
    expect(statusEvents.at(-1)).toMatchObject({ status: 'done' });

    expect(summary.feature).toBe('test feature');
    expect(phaseTimings.review).toBeGreaterThanOrEqual(0);
    expect(summary.reviewPacket).toMatchObject({
      jsonPath: REVIEW_PACKET_JSON_FILE,
      markdownPath: REVIEW_PACKET_MARKDOWN_FILE,
      finalReviewStatus: 'written',
    });
    const packetPath = join(sessionDir(projectDir, sessionId), REVIEW_PACKET_JSON_FILE);
    expect(existsSync(packetPath)).toBe(true);
    const packet = ReviewPacketSchema.parse(JSON.parse(readFileSync(packetPath, 'utf-8')));
    expect(packet.finalReview.status).toBe('written');
    expect(existsSync(join(sessionDir(projectDir, sessionId), REVIEW_PACKET_MARKDOWN_FILE))).toBe(
      true,
    );
  });

  it('feeds the recorded validation output into the review prompt for verbatim quoting', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nAdd titleCase.\n', null);

    const task = makeTask({ id: 'T001', status: 'done' });
    const ledger = withUpdatedTask(
      createEvidenceLedger({ sessionId, feature: 'feat', tasks: [task] }),
      task.id,
      (entry) => ({
        ...entry,
        status: 'done',
        validation: [
          {
            stage: 'test',
            passed: true,
            command: 'npm test',
            output: 'Test Files  1 passed (1)\n     Tests  4 passed (4)',
          },
        ],
      }),
    );
    writeEvidenceLedger({ projectDir, sessionId }, ledger);

    const reviewPrompts: string[] = [];
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const reviewer = makePlanner({
      review: async (prompt: string) => {
        reviewPrompts.push(prompt);
        return { text: 'ok', usage: null };
      },
    });

    await runFinalReviewPhase({
      projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState([task], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
      taskBreakdowns: [],
    });

    expect(reviewPrompts[0]).toContain('## Recorded Validation Output');
    expect(reviewPrompts[0]).toContain('- test (`npm test`): passed');
    expect(reviewPrompts[0]).toContain('Tests  4 passed (4)');
    expect(reviewPrompts[0]).toContain(
      'quote the relevant line verbatim from the Recorded Validation Output section',
    );
  });

  it('persists the review usage through the continuation loop on the sinks path', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);

    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const reviewer = makePlanner({
      review: async () => ({ text: 'ok', usage: { inputTokens: 200, outputTokens: 40 } }),
    });

    const { state } = await runFinalReviewPhase({
      projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      summaryBase: SUMMARY_BASE,
      taskBreakdowns: [],
    });

    expect(state.tokenUsage.reviewerInput).toBe(200);
    expect(state.tokenUsage.reviewerOutput).toBe(40);
    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.phase).toBe('complete');
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

    const reviewPrompts: string[] = [];
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const reviewer = makePlanner({
      review: async (prompt: string) => {
        reviewPrompts.push(prompt);
        return { text: 'ok', usage: null };
      },
    });
    const task = makeTask({
      id: 'T001',
      title: 'State fallback task title',
      description: 'State fallback marker: rotate audit log checksum.',
      status: 'done',
    });

    await runFinalReviewPhase({
      projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState([task], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
      taskBreakdowns: [],
    });

    expect(reviewPrompts[0]).toContain(
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
    reviewPrompts.length = 0;

    await runFinalReviewPhase({
      projectDir: fallbackProjectDir,
      sessionId: fallbackSessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState([task], fallbackRunStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
      taskBreakdowns: [],
    });

    expect(reviewPrompts[0]).toContain('State fallback marker: rotate audit log checksum.');
  });

  it('does not complete the workflow when the reviewer throws', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);

    const review = async () => {
      throw new Error('reviewer crashed');
    };
    const completions: Summary[] = [];
    const onComplete = (s: Summary) => {
      completions.push(s);
    };
    const { callbacks } = makeCallbacks({ onComplete });
    const { bus, events } = makeBusRecorder();
    const reviewer = makePlanner({ review });

    const state = allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead);
    const phaseTimings: Record<string, number> = {};

    const { summary } = await runFinalReviewPhase({
      projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state,
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
      taskBreakdowns: [],
      phaseTimings,
    });

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    const message = errorEvent && 'message' in errorEvent ? errorEvent.message : '';
    expect(message.length).toBeGreaterThan(0);

    const reviewPath = join(sessionDir(projectDir, sessionId), REVIEW_FILE);
    expect(existsSync(reviewPath)).toBe(false);

    expect(phaseTimings.review).toBeGreaterThanOrEqual(0);
    expect(completions).toEqual([]);
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(false);
    expect(loadState({ projectDir, sessionId })?.phase).toBe('final-review');
    expect(summary).toBeDefined();
    expect(summary.reviewPacket?.finalReviewStatus).toBe('failed');
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

    const reviewer = makePlanner({
      review: vi.fn(async () => {
        throw new Error('reviewer unreachable');
      }),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const { summary } = await runFinalReviewPhase({
      projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState([task], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
      taskBreakdowns: [],
    });

    expect(reviewer.review).toHaveBeenCalledTimes(1);
    expect(summary.reviewPacket?.finalReviewStatus).toBe('failed');
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

    const reviewer = makePlanner({
      review: async () => {
        throw new Error('reviewer unreachable');
      },
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await runFinalReviewPhase({
      projectDir,
      sessionId,
      config: makeNoValidationConfig({ reviewer: REVIEWER_RUNNER }),
      callbacks,
      bus,
      state: allTasksDoneState([task], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
      taskBreakdowns: [],
    });

    const failure = events.find((event) => event.type === 'error');
    expect(failure?.message).toContain(REVIEWER_IDENTITY);
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
      review: async () => {
        controller.abort(new DOMException('The user aborted a request.', 'AbortError'));
        throw new DOMException('The user aborted a request.', 'AbortError');
      },
    });
    const phaseTimings: Record<string, number> = {};

    const { summary } = await runFinalReviewPhase({
      projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState([makeTask({ id: 'T001', status: 'done' })], runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      signal: controller.signal,
      summaryBase: SUMMARY_BASE,
      taskBreakdowns: [],
      phaseTimings,
    });

    expect(summary).toBeDefined();
    expect(completions).toEqual([]);
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(false);
    expect(phaseTimings.review).toBeGreaterThanOrEqual(0);
    expect(existsSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE))).toBe(false);
  });

  it('works without a phaseTimings map (metadata argument remains optional)', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);

    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const reviewer = makePlanner({
      review: vi.fn().mockResolvedValue({ text: 'ok', usage: null }),
    });
    const state = allTasksDoneState([], runStartHead);

    const { summary: result } = await runFinalReviewPhase({
      projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state,
      reviewer,
      summaryBase: SUMMARY_BASE,
      taskBreakdowns: [],
    });

    expect(result).toBeDefined();
    expect(result.totalTasks).toBe(0);
  });

  it('writes active briefHash into the drift report artifact', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const reviewer = makePlanner({
      review: vi.fn().mockResolvedValue({ text: 'ok', usage: null }),
    });
    const tasks = [makeTask({ id: 'T001', file: 'src/hello.ts', status: 'done' })];

    // The completed task's target file is present in the working tree, so the
    // run's changed-file universe covers it and no missing_expected_file fires.
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/hello.ts'), 'export const hello = () => "hi";\n');

    await runFinalReviewPhase({
      projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState(tasks, runStartHead),
      reviewer,
      summaryBase: SUMMARY_BASE,
      taskBreakdowns: [],
    });

    const drift = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), DRIFT_REPORT_FILE), 'utf8'),
    );
    expect(drift.briefHash).toBe(hashTaskBrief(tasks));
    expect(drift.changedFiles).toContain('src/hello.ts');
    expect(drift.findings).toEqual([]);
  });

  it('fails the review instead of guessing the run boundary when state has no run-start baseline', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/feature.ts'), 'export const feature = true;\n');

    const task = makeTask({ id: 'T001', file: 'src/feature.ts', status: 'done' });
    const { changedFilesBaseline: _dropped, ...state } = allTasksDoneState([task], runStartHead);
    const completions: Summary[] = [];
    const { callbacks } = makeCallbacks({
      onComplete: (s: Summary) => {
        completions.push(s);
      },
    });
    const { bus, events } = makeBusRecorder();
    const review = vi.fn().mockResolvedValue({ text: 'ok', usage: null });

    const { summary } = await runFinalReviewPhase({
      projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state,
      reviewer: makePlanner({ review }),
      summaryBase: SUMMARY_BASE,
      taskBreakdowns: [],
    });

    const errorEvent = events.find((event) => event.type === 'error');
    const message = errorEvent && 'message' in errorEvent ? errorEvent.message : '';
    expect(message).toContain(finalReviewError.missingRunBaseline().message);
    expect(review).not.toHaveBeenCalled();
    expect(existsSync(join(sessionDir(projectDir, sessionId), DRIFT_REPORT_FILE))).toBe(false);
    expect(existsSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE))).toBe(false);
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(false);
    expect(completions).toEqual([]);
    expect(loadState({ projectDir, sessionId })?.phase).toBe('final-review');
    expect(summary.reviewPacket?.finalReviewStatus).toBe('failed');
  });

  it('fails drift for a rolling-only out-of-scope path absent at run start', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/feature.ts'), 'export const feature = true;\n');
    writeFileSync(join(projectDir, 'src/hook-output.ts'), 'export const hookOutput = true;\n');

    const task = makeTask({
      id: 'T001',
      file: 'src/feature.ts',
      status: 'done',
      scope: { outOfBounds: ['docs/**'] },
    });
    const ledger = withUpdatedTask(
      createEvidenceLedger({ sessionId, feature: 'feat', tasks: [task] }),
      task.id,
      (entry) => ({ ...entry, changedFiles: [task.file] }),
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
    const reviewer = makePlanner({
      review: vi.fn().mockResolvedValue({ text: 'ok', usage: null }),
    });

    await runFinalReviewPhase({
      projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state,
      reviewer,
      summaryBase: SUMMARY_BASE,
      taskBreakdowns: [],
    });

    const drift = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), DRIFT_REPORT_FILE), 'utf8'),
    );
    expect(
      drift.findings.find((finding: { file?: string }) => finding.file === 'src/hook-output.ts'),
    ).toMatchObject({
      code: 'out_of_scope_file',
      severity: 'error',
    });
    expect(drift.passed).toBe(false);
  });

  it('includes untracked created-file content in the review prompt diff', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);

    mkdirSync(join(projectDir, 'src'), { recursive: true });
    const marker = 'UNTRACKED_REVIEW_MARKER_42';
    writeFileSync(join(projectDir, 'src/hello.ts'), `export const x = "${marker}";\n`);

    const reviewPrompts: string[] = [];
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const reviewer = makePlanner({
      review: async (prompt: string) => {
        reviewPrompts.push(prompt);
        return { text: 'ok', usage: null };
      },
    });
    const tasks = [makeTask({ id: 'T001', file: 'src/hello.ts', status: 'done' })];

    await runFinalReviewPhase({
      projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState(tasks, runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
      taskBreakdowns: [],
    });

    expect(reviewPrompts[0]).toContain(marker);
  });

  it('derives the review diff and drift universe from per-task commits when the tree is clean', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);

    // Per-task commit strategy: the implemented file is committed (with the
    // run-authored message prefix) and the working tree is left clean — so a
    // raw `git status` / `git diff` universe is empty and would (incorrectly)
    // produce an empty review diff plus a false missing_expected_file warning.
    const committedMarker = 'COMMITTED_REVIEW_MARKER_77';
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/feature.ts'), `export const y = "${committedMarker}";\n`);
    execSync('git add src/feature.ts', { cwd: projectDir, stdio: 'pipe' });
    execSync('git commit -m "feat(splitbrief): T001 - add feature"', {
      cwd: projectDir,
      stdio: 'pipe',
    });

    const reviewPrompts: string[] = [];
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const reviewer = makePlanner({
      review: async (prompt: string) => {
        reviewPrompts.push(prompt);
        return { text: 'ok', usage: null };
      },
    });
    const tasks = [makeTask({ id: 'T001', file: 'src/feature.ts', status: 'done' })];

    await runFinalReviewPhase({
      projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState(tasks, runStartHead),
      reviewer,
      metadata: TEST_METADATA,
      summaryBase: SUMMARY_BASE,
      taskBreakdowns: [],
    });

    expect(reviewPrompts[0]).toContain(committedMarker);

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

    const reviewPrompts: string[] = [];
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const reviewer = makePlanner({
      review: async (prompt: string) => {
        reviewPrompts.push(prompt);
        return { text: 'ok', usage: null };
      },
    });
    const task = makeTask({ id: 'T001', file: 'src/post-run.ts', status: 'done' });
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
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state,
      reviewer,
      summaryBase: SUMMARY_BASE,
      taskBreakdowns: [],
    });

    expect(reviewPrompts[0]).toContain(postRunMarker);
    expect(reviewPrompts[0]).not.toContain(preRunMarker);
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

    const reviewPrompts: string[] = [];
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const reviewer = makePlanner({
      review: async (prompt: string) => {
        reviewPrompts.push(prompt);
        return { text: 'ok', usage: null };
      },
    });
    const task = makeTask({ id: 'T001', file: 'src/from-unborn.ts', status: 'done' });

    await runFinalReviewPhase({
      projectDir,
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
      taskBreakdowns: [],
    });

    expect(reviewPrompts[0]).toContain(marker);
    const drift = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), DRIFT_REPORT_FILE), 'utf8'),
    );
    expect(drift.changedFiles).toContain('src/from-unborn.ts');
  });

  it('keeps the complete diff for drift while bounding the review prompt at 100,000 characters', async () => {
    const { projectDir, sessionId, runStartHead } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    const prohibitedMarker = 'PROHIBITED_AFTER_PROMPT_BOUNDARY';
    writeFileSync(
      join(projectDir, 'src/large.ts'),
      `${'x'.repeat(101_000)}\n${prohibitedMarker}\n`,
    );

    const reviewPrompts: string[] = [];
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const reviewer = makePlanner({
      review: async (prompt: string) => {
        reviewPrompts.push(prompt);
        return { text: 'ok', usage: null };
      },
    });
    const task = makeTask({
      id: 'T001',
      file: 'src/large.ts',
      status: 'done',
      scope: { outOfBounds: [prohibitedMarker] },
    });

    await runFinalReviewPhase({
      projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      state: allTasksDoneState([task], runStartHead),
      reviewer,
      summaryBase: SUMMARY_BASE,
      taskBreakdowns: [],
    });

    const drift = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), DRIFT_REPORT_FILE), 'utf8'),
    );
    expect(drift.findings).toContainEqual(
      expect.objectContaining({
        code: 'out_of_bounds_text_match',
        message: expect.stringContaining(prohibitedMarker),
      }),
    );
    const promptDiff = reviewPrompts[0]
      ?.split('## Implementation Diff\n')[1]
      ?.split('\n## Deterministic Drift Report')[0];
    expect(promptDiff).not.toContain(prohibitedMarker);
    expect(promptDiff).toContain('diff truncated');
  });
});
