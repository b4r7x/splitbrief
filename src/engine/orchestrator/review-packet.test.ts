import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeSummary, makeUsage } from '#testing/helpers/factories/summary.js';
import { makeBriefHash, makeTask } from '#testing/helpers/factories/task.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { RunSnapshotKind, SnapshotManifest, SnapshotPhase } from '../../core/schemas/snapshot.js';
import { createInitialState } from '../../core/state/machine.js';
import { appendEngineEvent, saveState } from '../../core/state/persistence.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import {
  BRIEF_QUALITY_FILE,
  DRIFT_CHAINS_FILE,
  DRIFT_REPORT_FILE,
  EVIDENCE_FILE,
  REVIEW_FILE,
  REVIEW_PACKET_JSON_FILE,
  REVIEW_PACKET_MARKDOWN_FILE,
  READINESS_FILE,
  SESSION_LOG_FILE,
  STATE_FILE,
  reviewPacketJsonPath,
  reviewPacketMarkdownPath,
  sessionDir,
} from '../../core/paths.js';
import { writeSecureFile } from '../../lib/fs.js';
import { ReviewPacketSchema } from '../../core/schemas/review-packet.js';
import { writeManifest } from '../snapshots/store.js';
import { recordRunSnapshot } from '../snapshots/run.js';
import { writeDriftReport } from './drift.js';
import { writeDriftChainState } from './drift-chain-state.js';
import {
  createEvidenceLedger,
  recordFinalReviewEvidence,
  recordLocalTaskEvidence,
  recordRetryOrEscalationEvidence,
  recordSkippedTaskEvidence,
  writeEvidenceLedger,
} from './evidence.js';
import { buildSummary } from './summary.js';
import { writeReviewPacket } from './review-packet.js';

const SESSION_ID = 'sess-review-packet';

let dirs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-29T10:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupSession(name: string): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  ensureSessionDir(projectDir, SESSION_ID);
  return { projectDir, sessionId: SESSION_ID };
}

function makeState(tasks: Task[], overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    ...createInitialState('review packet feature'),
    phase: 'complete',
    feature: 'review packet feature',
    startedAt: '2026-04-29T09:00:00.000Z',
    tasks,
    tokenUsage: makeUsage({
      plannerInput: 1000,
      plannerOutput: 500,
      implementerInput: 2000,
      implementerOutput: 1000,
      escalationInput: 300,
      escalationOutput: 100,
    }),
    plannerTool: 'claude-code',
    plannerModel: 'sonnet',
    implementerTool: 'ollama',
    implementerModel: 'qwen',
    ...overrides,
  };
}

function makeSnapshot(opts: {
  id: string;
  name?: string;
  phase?: SnapshotPhase;
  taskIndex?: number;
  trackedFileCount?: number;
}): SnapshotManifest {
  return {
    version: 1,
    id: opts.id,
    sessionId: SESSION_ID,
    createdAt: '2026-04-29T09:30:00.000Z',
    phase: opts.phase ?? 'manual',
    fileHashes: {},
    fileEntries: [],
    trackedFileCount: opts.trackedFileCount ?? 4,
    ...(opts.name !== undefined && { name: opts.name }),
    ...(opts.taskIndex !== undefined && { taskIndex: opts.taskIndex }),
  };
}

async function writeCheckpoint(projectDir: string, manifest: SnapshotManifest, kind?: RunSnapshotKind): Promise<void> {
  await writeManifest(projectDir, SESSION_ID, manifest);
  await recordRunSnapshot(projectDir, SESSION_ID, manifest, kind);
}

function writeBriefQuality(projectDir: string): void {
  writeSecureFile(
    join(sessionDir(projectDir, SESSION_ID), BRIEF_QUALITY_FILE),
    JSON.stringify({
      version: 1,
      passed: false,
      score: 0.8,
      issues: [
        { taskId: 'T004', severity: 'error', code: 'missing_evidence', message: 'Task T004 has no evidence' },
        { taskId: 'T002', severity: 'warning', code: 'non_atomic_task', message: 'Task T002 has no type definitions' },
      ],
    }, null, 2) + '\n',
  );
}

function writeReview(projectDir: string): void {
  writeSecureFile(
    join(sessionDir(projectDir, SESSION_ID), REVIEW_FILE),
    '### Verdict\nNeeds review.\n\n### Findings\n' + 'A concise finding. '.repeat(80),
  );
}

function writeReadiness(projectDir: string): void {
  writeSecureFile(
    join(sessionDir(projectDir, SESSION_ID), READINESS_FILE),
    JSON.stringify({
      type: 'start-readiness',
      generatedAt: '2026-04-29T08:59:00.000Z',
      status: 'ready-with-warnings',
      nextAction: 'continue',
      blockerCount: 0,
      warningCount: 1,
      checks: [
        {
          id: 'repo.dirty',
          severity: 'warning',
          summary: 'Repository has local edits before the run.',
        },
      ],
    }, null, 2) + '\n',
  );
}

function makeSummaryForPacket(overrides = {}) {
  return makeSummary({
    feature: 'review packet feature',
    totalTasks: 4,
    completedByLocal: 1,
    escalatedToPlanner: 1,
    skipped: 1,
    failed: 1,
    totalTime: 120_000,
    plannerTool: 'claude-code',
    plannerModel: 'sonnet',
    implementerTool: 'ollama',
    implementerModel: 'qwen',
    mode: 'standard',
    tokenUsage: makeUsage({
      plannerInput: 1000,
      plannerOutput: 500,
      implementerInput: 2000,
      implementerOutput: 1000,
      escalationInput: 300,
      escalationOutput: 100,
    }),
    costBreakdown: {
      hypotheticalCost: 10,
      actualPlannerCost: 1,
      actualImplementerCost: 0.5,
      totalActualCost: 1.5,
      savingsAmount: 8.5,
      savingsPercentage: 85,
      localCompletionRate: 0.25,
      hasPricedUsage: true,
      hasUnpricedUsage: true,
      hasSavingsEstimate: true,
    },
    taskBreakdown: [
      {
        taskId: 'T001' as Task['id'],
        taskTitle: 'Local task',
        method: 'local',
        implementerTokens: 300,
        escalationTokens: 0,
        retryCount: 0,
        cost: 0,
        tool: 'ollama',
        model: 'qwen',
        implementerProfile: 'local-qwen',
        contextFit: 'fits',
      },
      {
        taskId: 'T002' as Task['id'],
        taskTitle: 'Escalated task',
        method: 'escalated-full',
        implementerTokens: 400,
        escalationTokens: 100,
        retryCount: 2,
        cost: 1,
        tool: 'anthropic',
        model: 'sonnet',
        implementerProfile: 'planner',
        contextFit: 'tight',
        routingReason: 'Task was near context limit',
      },
    ],
    ...overrides,
  });
}

async function writeCompleteArtifacts(projectDir: string, state: WorkflowState, tasks: Task[]): Promise<void> {
  saveState(projectDir, SESSION_ID, state);
  const briefHash = makeBriefHash(tasks);
  let ledger = createEvidenceLedger({ sessionId: SESSION_ID, feature: state.feature, mode: 'standard', tasks, briefHash });
  ledger = recordLocalTaskEvidence({
    ledger,
    task: tasks[0] ?? makeTask(),
    status: 'done',
    method: 'local',
    validation: [{ stage: 'tsc', passed: true }],
    changedFiles: ['src/local.ts'],
    briefHash,
  });
  ledger = recordRetryOrEscalationEvidence({
    ledger,
    task: tasks[1] ?? makeTask(),
    status: 'escalated',
    method: 'escalated-full',
    retries: 2,
    validation: [{ stage: 'test', passed: false, error: 'test failed' }],
    changedFiles: ['src/escalated.ts'],
    escalated: true,
    briefHash,
  });
  ledger = recordSkippedTaskEvidence({
    ledger,
    task: tasks[2] ?? makeTask(),
    reason: 'recovery retry-exhausted',
    briefHash,
  });
  ledger = recordRetryOrEscalationEvidence({
    ledger,
    task: tasks[3] ?? makeTask(),
    status: 'failed',
    method: 'failed',
    retries: 3,
    validation: [{ stage: 'lint', passed: false, error: 'lint failed' }],
    changedFiles: ['src/failed.ts'],
    escalated: false,
    briefHash,
  });
  ledger = recordFinalReviewEvidence({ ledger, status: 'written' });
  writeEvidenceLedger(projectDir, SESSION_ID, ledger);

  writeDriftReport(projectDir, SESSION_ID, {
    version: 1,
    passed: false,
    score: 0.67,
    changedFiles: ['src/local.ts', 'src/escalated.ts', 'src/outside.ts', 'src/failed.ts'],
    expectedFiles: ['src/local.ts', 'src/escalated.ts', 'src/skipped.ts', 'src/failed.ts'],
    findings: [
      {
        severity: 'warning',
        code: 'out_of_scope_file',
        file: 'src/outside.ts',
        message: 'src/outside.ts was changed but no Task Brief targets it.',
      },
      {
        severity: 'error',
        code: 'failed_task_with_diff',
        taskId: 'T004',
        file: 'src/failed.ts',
        message: 'Failed task T004 left changes in src/failed.ts.',
      },
    ],
    briefHash,
  });
  writeDriftChainState(projectDir, SESSION_ID, {
    version: 1,
    sessionId: SESSION_ID,
    activeChain: { entries: [], uniqueFiles: [], score: 0 },
    emittedChains: [
      {
        chainLength: 2,
        score: 0.72,
        uniqueOutOfBoundsFiles: ['src/outside.ts'],
        representativePath: 'src/outside.ts',
        detectedAtTaskId: 'T004',
        ts: Date.now(),
      },
    ],
  });
  writeBriefQuality(projectDir);
  writeReview(projectDir);
  writeReadiness(projectDir);
  await writeCheckpoint(projectDir, makeSnapshot({ id: 'snap-pre-final', name: 'pre-final-review', taskIndex: 3 }), 'pre-final-review');

  appendEngineEvent(projectDir, SESSION_ID, {
    type: 'workflow_complete',
    ts: Date.parse('2026-04-29T09:59:00.000Z'),
    phase: 'complete',
  });
  appendEngineEvent(projectDir, SESSION_ID, {
    type: 'task_retry',
    ts: Date.parse('2026-04-29T09:45:00.000Z'),
    phase: 'validating-task',
    taskId: tasks[1]?.id ?? ('T002' as Task['id']),
    attempt: 2,
    maxRetries: 3,
    error: 'test failed',
  });
  appendEngineEvent(projectDir, SESSION_ID, {
    type: 'task_skipped',
    ts: Date.parse('2026-04-29T09:46:00.000Z'),
    phase: 'implementing',
    taskId: tasks[2]?.id ?? ('T003' as Task['id']),
    title: 'Skipped task',
    reason: 'recovery retry-exhausted',
  });
  appendEngineEvent(projectDir, SESSION_ID, {
    type: 'warning',
    ts: Date.parse('2026-04-29T09:47:00.000Z'),
    phase: 'implementing',
    message: 'context fit was tight',
  });
  appendEngineEvent(projectDir, SESSION_ID, {
    type: 'task_started',
    ts: Date.parse('2026-04-29T09:48:00.000Z'),
    phase: 'implementing',
    taskId: tasks[1]?.id ?? ('T002' as Task['id']),
    title: 'Escalated task',
    index: 2,
    total: 4,
    file: 'src/escalated.ts',
    action: 'modify',
    contextFit: 'tight',
    routingReason: 'Task was near context limit',
  });
}

describe('review packet writer', () => {
  it('writes canonical JSON and human Markdown from complete run artifacts', async () => {
    const { projectDir, sessionId } = setupSession('review-packet-complete');
    const tasks = [
      makeTask({ id: 'T001', title: 'Local task', status: 'done', file: 'src/local.ts', evidence: ['tsc passed'] }),
      makeTask({ id: 'T002', title: 'Escalated task', status: 'escalated', file: 'src/escalated.ts' }),
      makeTask({ id: 'T003', title: 'Skipped task', status: 'skipped', file: 'src/skipped.ts' }),
      makeTask({ id: 'T004', title: 'Failed task', status: 'failed', file: 'src/failed.ts' }),
    ];
    const state = makeState(tasks);
    await writeCompleteArtifacts(projectDir, state, tasks);

    const packet = await writeReviewPacket({
      projectDir,
      sessionId,
      summary: makeSummaryForPacket(),
      state,
      finalReviewStatus: 'written',
    });

    expect(existsSync(reviewPacketJsonPath(projectDir, sessionId))).toBe(true);
    expect(existsSync(reviewPacketMarkdownPath(projectDir, sessionId))).toBe(true);
    const rawJson = readFileSync(reviewPacketJsonPath(projectDir, sessionId), 'utf8');
    const parsed = JSON.parse(rawJson);
    expect(ReviewPacketSchema.safeParse(parsed).success).toBe(true);
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort((a, b) => a.localeCompare(b)));
    expect(ReviewPacketSchema.safeParse({ ...packet, version: 2 }).success).toBe(false);

    expect(packet.finalReview).toMatchObject({ status: 'written', path: REVIEW_FILE, evidenceStatus: 'written' });
    expect(packet.readiness).toMatchObject({
      path: READINESS_FILE,
      present: true,
      status: 'ready-with-warnings',
      nextAction: 'continue',
      blockerCount: 0,
      warningCount: 1,
      checks: [
        {
          id: 'repo.dirty',
          severity: 'warning',
          summary: 'Repository has local edits before the run.',
        },
      ],
    });
    expect(packet.finalReview.excerpt?.length).toBeLessThanOrEqual(500);
    expect(packet.changes.changedFiles).toEqual(['src/escalated.ts', 'src/failed.ts', 'src/local.ts', 'src/outside.ts']);
    expect(packet.changes.outOfScopeFiles).toEqual(['src/outside.ts']);
    expect(packet.checkpoints.preFinalReview?.restoreCommand).toBe('diptych snapshot restore snap-pre-final');
    expect(packet.validation.summary).toMatchObject({ passed: 1, failed: 1, skipped: 1, escalated: 1 });
    expect(packet.drift.findingsBySeverity.warning).toHaveLength(1);
    expect(packet.drift.findingsBySeverity.error).toHaveLength(1);
    expect(packet.drift.chainSummary.topChain?.representativePath).toBe('src/outside.ts');
    expect(packet.escalations.retries).toContainEqual({ taskId: 'T002', retryCount: 2, lastError: 'test failed' });
    expect(packet.escalations.escalatedTasks).toContainEqual({ taskId: 'T002', title: 'Escalated task', method: 'escalated-full' });
    expect(packet.escalations.skippedTasks).toContainEqual({ taskId: 'T003', title: 'Skipped task', reason: 'recovery retry-exhausted' });
    expect(packet.escalations.failedTasks).toContainEqual({ taskId: 'T004', title: 'Failed task' });
    expect(packet.escalations.warnings).toHaveLength(1);
    expect(packet.cost.taskRouting[1]).toMatchObject({ taskId: 'T002', contextFit: 'tight', implementerProfile: 'planner' });
    expect(packet.missingArtifacts).not.toContain(EVIDENCE_FILE);
    expect(packet.missingArtifacts).not.toContain(DRIFT_REPORT_FILE);
    expect(packet.missingArtifacts).not.toContain(REVIEW_FILE);

    const markdown = readFileSync(reviewPacketMarkdownPath(projectDir, sessionId), 'utf8');
    expect(markdown).toContain('## Run Header');
    expect(markdown).toContain('## Readiness');
    expect(markdown).toContain('- Status: ready-with-warnings');
    expect(markdown).toContain('- warning repo.dirty: Repository has local edits before the run.');
    expect(markdown).toContain('## Change Summary');
    expect(markdown).toContain('## Checkpoints And Restore');
    expect(markdown).toContain('## Validation And Evidence');
    expect(markdown).toContain('## Drift And Scope');
    expect(markdown).toContain('## Escalations, Retries, Skips, And Warnings');
    expect(markdown).toContain('## Recovery Decisions');
    expect(markdown).toContain('## Cost And Routing');
    expect(markdown).toContain('## Planner Final Review');
    expect(markdown).toContain('## Human Reviewer Checklist');
    expect(markdown).toContain('- [ ] Inspect changed files against the requested scope.');
    expect(markdown).toContain('diptych snapshot diff snap-pre-final');
    expect(markdown).toContain('Restore is hash-guarded');
    expect(markdown).toContain('--force is destructive');
    expect(markdown).toContain('Partial restore is expected');
    expect(markdown).toContain('Snapshots exclude .git/, .diptych/, node_modules/, and .trees/.');
    expect(markdown).toContain('Excluded paths: .git/, .diptych/, node_modules/, .trees/');

    const summaryWithRollups = buildSummary({
      feature: state.feature,
      state,
      startTime: Date.now() - 120_000,
      plannerTool: 'claude-code',
      plannerModel: 'sonnet',
      implementerTool: 'ollama',
      implementerModel: 'qwen',
      projectDir,
      sessionId,
      mode: 'standard',
    });
    expect(summaryWithRollups.reviewPacket).toMatchObject({
      jsonPath: REVIEW_PACKET_JSON_FILE,
      markdownPath: REVIEW_PACKET_MARKDOWN_FILE,
      finalReviewStatus: 'written',
      missingArtifactCount: packet.missingArtifacts.length,
    });
    expect(summaryWithRollups.checkpointSummary).toMatchObject({
      count: 1,
      preFinalReviewId: 'snap-pre-final',
      restoreCommand: 'diptych snapshot restore snap-pre-final',
    });
  });

  it('does not promote inferred pre-final-review names into the canonical packet rollup', async () => {
    const { projectDir, sessionId } = setupSession('review-packet-inferred-checkpoint');
    const tasks = [makeTask({ id: 'T001', title: 'Local task', status: 'done', file: 'src/local.ts' })];
    const state = makeState(tasks);
    const manifest = makeSnapshot({ id: 'manual-pre-final-name', name: 'pre-final-review' });
    await writeCheckpoint(projectDir, manifest);

    const packet = await writeReviewPacket({
      projectDir,
      sessionId,
      summary: makeSummary({ feature: state.feature, totalTasks: 1, completedByLocal: 1, mode: 'standard' }),
      state,
      finalReviewStatus: 'written',
    });

    expect(packet.checkpoints.items[0]).toMatchObject({
      id: 'manual-pre-final-name',
      kind: 'manual',
      inferredKind: 'pre-final-review',
      isRunCheckpoint: true,
    });
    expect(packet.checkpoints.preFinalReview).toBeNull();

    const markdown = readFileSync(reviewPacketMarkdownPath(projectDir, sessionId), 'utf8');
    expect(markdown).toContain('manual (inferred pre-final-review)');
  });

  it('records missing optional artifacts and still writes a failed final-review packet', async () => {
    const { projectDir, sessionId } = setupSession('review-packet-missing');
    const tasks = [makeTask({ id: 'T001', status: 'done', file: 'src/only.ts' })];
    const state = makeState(tasks);

    const packet = await writeReviewPacket({
      projectDir,
      sessionId,
      summary: makeSummary({ feature: state.feature, totalTasks: 1, completedByLocal: 1, mode: 'standard' }),
      state,
      finalReviewStatus: 'failed',
    });

    expect(packet.finalReview.status).toBe('failed');
    expect(packet.recoveryDecisions.currentIssue).toBeNull();
    expect(packet.recoveryDecisions.sourceArtifacts).toEqual([
      { path: STATE_FILE, present: false },
      { path: SESSION_LOG_FILE, present: false },
      { path: EVIDENCE_FILE, present: false },
    ]);
    expect(packet.recoveryDecisions.unresolvedRisks).toContain(
      'Recovery events are unavailable because session.jsonl is missing.',
    );
    expect(packet.missingArtifacts).toEqual(expect.arrayContaining([
      STATE_FILE,
      SESSION_LOG_FILE,
      EVIDENCE_FILE,
      DRIFT_REPORT_FILE,
      DRIFT_CHAINS_FILE,
      BRIEF_QUALITY_FILE,
      READINESS_FILE,
      REVIEW_FILE,
      'git status',
      'snapshots/run-ledger.json',
    ]));
    expect(existsSync(reviewPacketJsonPath(projectDir, sessionId))).toBe(true);
    expect(existsSync(reviewPacketMarkdownPath(projectDir, sessionId))).toBe(true);
  });

  it('reconstructs recovery decisions for selected, skipped, paused, resumed, aborted, failed, and unresolved paths', async () => {
    const { projectDir, sessionId } = setupSession('review-packet-recovery');
    const task = makeTask({ id: 'T010', status: 'in_progress', file: 'src/recovery.ts' });
    const state = makeState([task], {
      phase: 'validating-task',
      pendingRecovery: {
        id: 'issue-unresolved',
        reason: 'validation-failed',
        phase: 'validating-task',
        status: 'awaiting-user',
        taskId: task.id,
        taskTitle: task.title,
        files: [task.file],
        affectedTaskIds: [task.id],
        message: 'Validation failed',
        details: ['lint failed'],
        availableActions: ['retry-same-worker', 'pause-run', 'abort-workflow'],
        recommendedAction: 'retry-same-worker',
        selectedAction: 'retry-same-worker',
        selectedAt: '2026-04-29T09:55:00.000Z',
        createdAt: '2026-04-29T09:50:00.000Z',
      },
    });
    saveState(projectDir, sessionId, state);
    writeReview(projectDir);
    writeDriftReport(projectDir, sessionId, {
      version: 1,
      passed: true,
      score: 1,
      changedFiles: [],
      expectedFiles: [task.file],
      findings: [],
      briefHash: null,
    });
    writeDriftChainState(projectDir, sessionId, {
      version: 1,
      sessionId,
      activeChain: { entries: [], uniqueFiles: [], score: 0 },
      emittedChains: [],
    });
    writeBriefQuality(projectDir);

    appendEngineEvent(projectDir, sessionId, { type: 'workflow_resumed', ts: Date.parse('2026-04-29T09:40:00.000Z'), phase: 'implementing' });
    appendEngineEvent(projectDir, sessionId, {
      type: 'recovery_prompted',
      ts: Date.parse('2026-04-29T09:40:30.000Z'),
      phase: 'implementing',
      issueId: 'issue-skip',
      reason: 'retry-exhausted',
      taskId: task.id,
      files: [task.file],
      affectedTaskIds: [task.id],
      availableActions: ['skip-current-task', 'pause-run', 'abort-workflow'],
      recommendedAction: 'skip-current-task',
    });
    appendEngineEvent(projectDir, sessionId, {
      type: 'recovery_action_selected',
      ts: Date.parse('2026-04-29T09:41:00.000Z'),
      phase: 'implementing',
      issueId: 'issue-pause',
      reason: 'budget-paused',
      action: 'pause-run',
    });
    appendEngineEvent(projectDir, sessionId, {
      type: 'recovery_action_selected',
      ts: Date.parse('2026-04-29T09:42:00.000Z'),
      phase: 'implementing',
      issueId: 'issue-skip',
      reason: 'retry-exhausted',
      action: 'skip-current-task',
    });
    appendEngineEvent(projectDir, sessionId, {
      type: 'recovery_resolved',
      ts: Date.parse('2026-04-29T09:43:00.000Z'),
      phase: 'implementing',
      issueId: 'issue-skip',
      reason: 'retry-exhausted',
      action: 'skip-current-task',
      outcome: 'skipped-current-task',
    });
    appendEngineEvent(projectDir, sessionId, {
      type: 'recovery_action_selected',
      ts: Date.parse('2026-04-29T09:44:00.000Z'),
      phase: 'implementing',
      issueId: 'issue-abort',
      reason: 'implementation-error',
      action: 'abort-workflow',
    });
    appendEngineEvent(projectDir, sessionId, {
      type: 'recovery_resolved',
      ts: Date.parse('2026-04-29T09:45:00.000Z'),
      phase: 'implementing',
      issueId: 'issue-abort',
      reason: 'implementation-error',
      action: 'abort-workflow',
      outcome: 'aborted',
    });
    appendEngineEvent(projectDir, sessionId, {
      type: 'recovery_action_selected',
      ts: Date.parse('2026-04-29T09:46:00.000Z'),
      phase: 'implementing',
      issueId: 'issue-failed',
      reason: 'dependency-blocked',
      action: 'planner-split-rebase',
    });
    appendEngineEvent(projectDir, sessionId, {
      type: 'recovery_action_failed',
      ts: Date.parse('2026-04-29T09:47:00.000Z'),
      phase: 'implementing',
      issueId: 'issue-failed',
      reason: 'dependency-blocked',
      action: 'planner-split-rebase',
      message: 'planner-proposal-required',
    });

    const packet = await writeReviewPacket({
      projectDir,
      sessionId,
      summary: makeSummary({ feature: state.feature, totalTasks: 1, failed: 1, mode: 'standard' }),
      state,
      finalReviewStatus: 'written',
    });

    expect(packet.recoveryDecisions.currentIssue).toMatchObject({
      issueId: 'issue-unresolved',
      reason: 'validation-failed',
      selectedAction: 'retry-same-worker',
    });
    expect(packet.recoveryDecisions.selectedActions.map((entry) => entry.action)).toEqual([
      'pause-run',
      'skip-current-task',
      'abort-workflow',
      'planner-split-rebase',
    ]);
    expect(packet.recoveryDecisions.events.find((event) => event.type === 'recovery_prompted')).toMatchObject({
      issueId: 'issue-skip',
      reason: 'retry-exhausted',
      files: [task.file],
      affectedTaskIds: [task.id],
      availableActions: ['skip-current-task', 'pause-run', 'abort-workflow'],
      recommendedAction: 'skip-current-task',
    });
    expect(packet.recoveryDecisions.outcomes.map((outcome) => outcome.status)).toEqual(expect.arrayContaining([
      'paused',
      'resumed',
      'skipped',
      'aborted',
      'failed',
      'unresolved',
    ]));
    expect(packet.recoveryDecisions.unresolvedRisks).toEqual(expect.arrayContaining([
      'Recovery action failed for issue-failed: planner-proposal-required.',
      'Recovery issue issue-pause paused without a resolved event.',
      'validation-failed recovery issue is still awaiting-user',
    ]));
  });

  it('does not report a savings estimate when the summary marks savings unavailable', async () => {
    const { projectDir, sessionId } = setupSession('review-packet-unpriced');
    const task = makeTask({ id: 'T020', status: 'done', file: 'src/unpriced.ts' });
    const state = makeState([task]);
    writeReview(projectDir);

    const packet = await writeReviewPacket({
      projectDir,
      sessionId,
      summary: makeSummary({
        feature: state.feature,
        totalTasks: 1,
        completedByLocal: 1,
        mode: 'standard',
        estimatedCostSavings: '$0.00',
        costBreakdown: {
          hypotheticalCost: 0,
          actualPlannerCost: 0,
          actualImplementerCost: 0,
          totalActualCost: 0,
          savingsAmount: 0,
          savingsPercentage: 0,
          localCompletionRate: 1,
          hasPricedUsage: false,
          hasUnpricedUsage: true,
          hasSavingsEstimate: false,
          isTotalActualCostKnown: false,
          isAllPlannerBaselineKnown: false,
        },
      }),
      state,
      finalReviewStatus: 'written',
    });

    expect(packet.cost.estimatedCostSavings).toBeNull();
    const markdown = readFileSync(reviewPacketMarkdownPath(projectDir, sessionId), 'utf8');
    expect(markdown).toContain('- Actual cost: unavailable');
    expect(markdown).toContain('- Estimated savings: unavailable');
    expect(markdown).not.toContain('- Estimated savings: $0.00');
    expect(markdown).not.toContain('- Actual cost: $0.0000');
  });
});
