import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary, makeUsage } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import {
  READINESS_FILE,
  REVIEW_FILE,
  REVIEW_PACKET_JSON_FILE,
  REVIEW_PACKET_MARKDOWN_FILE,
  SESSION_LOG_FILE,
  STATE_FILE,
  sessionDir,
} from '../../../core/paths.js';
import { appendEngineEvent, saveState } from '../../../core/state/persistence.js';
import { saveSummary } from '../../../core/sessions/io.js';
import { writeSecureFile } from '../../../lib/fs.js';
import { taskId } from '../../../core/schemas/task.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';
import { createInitialState } from '../../../core/state/machine.js';
import { writeReviewPacket } from '../evidence/review-packet/review-packet.js';
import { buildRunExplain } from './explain.js';
import { formatRunExplain } from './format.js';

const SESSION_ID = '2026-04-29-explain';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupSession(name: string): string {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  ensureSessionDir(projectDir, SESSION_ID);
  return projectDir;
}

function writeReadiness(projectDir: string): void {
  writeSecureFile(
    join(sessionDir(projectDir, SESSION_ID), READINESS_FILE),
    JSON.stringify({
      type: 'start-readiness',
      generatedAt: '2026-04-29T08:00:00.000Z',
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

async function writeRichArtifacts(): Promise<string> {
  const projectDir = setupSession('explain-rich');
  const tasks = [
    makeTask({ id: 'T001', title: 'Local task', status: 'done', file: 'src/local.ts' }),
    makeTask({ id: 'T002', title: 'Tight task', status: 'escalated', file: 'src/tight.ts' }),
  ];
  const state = {
    ...createInitialState('explain feature'),
    phase: 'complete' as const,
    tasks,
    tokenUsage: makeUsage({ plannerInput: 1000, plannerOutput: 500, implementerInput: 2000, implementerOutput: 1000 }),
    plannerTool: 'claude-code',
    plannerModel: 'sonnet',
    implementerTool: 'ollama',
    implementerModel: 'qwen',
  };
  saveState(projectDir, SESSION_ID, state);
  writeReadiness(projectDir);
  writeSecureFile(join(sessionDir(projectDir, SESSION_ID), REVIEW_FILE), 'Final review ok.\n');
  appendEngineEvent(projectDir, SESSION_ID, {
    type: 'task_retry',
    ts: Date.parse('2026-04-29T09:00:00.000Z'),
    phase: 'validating-task',
    taskId: taskId('T002'),
    attempt: 1,
    maxRetries: 3,
    error: 'test failed',
  });
  appendEngineEvent(projectDir, SESSION_ID, {
    type: 'task_review_needed',
    ts: Date.parse('2026-04-29T09:01:00.000Z'),
    phase: 'implementing',
    taskId: taskId('T001'),
    taskTitle: 'Local task',
    status: 'done',
    filesTouched: ['src/local.ts'],
    validation: { passed: true, summary: 'validation passed', stages: [] },
    evidence: { summary: 'tsc passed', expected: [], observed: ['tsc passed'] },
    cost: { tokenUsage: state.tokenUsage },
    availableCommands: ['continue', 'redo', 'edit-notes', 'revise-plan', 'abort'],
  });
  appendEngineEvent(projectDir, SESSION_ID, {
    type: 'warning',
    ts: Date.parse('2026-04-29T09:02:00.000Z'),
    phase: 'implementing',
    message: 'context fit was tight',
  });

  const deterministic: NonNullable<CostPrediction['deterministic']> = {
    taskCount: 2,
    taskFitCounts: { fits: 1, tight: 1, overflow: 0, unknown: 0 },
    contextConfidenceCounts: {
      contextExplicit: 1,
      contextKnownCatalog: 0,
      contextCachedProvider: 0,
      contextConservativeFallback: 1,
      profileUnavailable: 0,
    },
    priceConfidenceCounts: { priceKnown: 1, priceUnknown: 1, profileUnavailable: 0 },
    tasks: [
      {
        taskId: 'T001',
        title: 'Local task',
        estimatedPromptTokens: 1200,
        selectedProfileId: 'local-small',
        contextFit: 'fits',
        contextConfidence: 'context-explicit',
        priceConfidence: 'price-known',
        estimatedImplementerCost: 0.01,
        hypotheticalPlannerCost: 0.12,
      },
      {
        taskId: 'T002',
        title: 'Tight task',
        estimatedPromptTokens: 7000,
        selectedProfileId: 'cheap-api',
        contextFit: 'tight',
        contextConfidence: 'context-conservative-fallback',
        priceConfidence: 'price-unknown',
        estimatedImplementerCost: null,
        hypotheticalPlannerCost: 0.18,
      },
    ],
    totals: {
      knownActualEstimate: null,
      hypotheticalAllPlanner: 0.3,
      estimatedSavings: null,
      unknownCostReason: ['implementer-price-unknown'],
    },
  };
  const summary = makeSummary({
    feature: 'explain feature',
    totalTasks: 2,
    completedByLocal: 1,
    escalatedToPlanner: 1,
    totalTime: 60_000,
    tokenUsage: state.tokenUsage,
    estimatedCostSavings: 'unavailable',
    plannerTool: 'claude-code',
    plannerModel: 'sonnet',
    implementerTool: 'ollama',
    implementerModel: 'qwen',
    mode: 'standard',
    costBreakdown: {
      hypotheticalCost: 0.3,
      actualPlannerCost: 0.01,
      actualImplementerCost: 0.01,
      totalActualCost: 0.02,
      savingsAmount: 0,
      savingsPercentage: 0,
      localCompletionRate: 0.5,
      hasPricedUsage: true,
      hasUnpricedUsage: true,
      hasSavingsEstimate: false,
      isTotalActualCostKnown: false,
      isAllPlannerBaselineKnown: true,
    },
    costPrediction: {
      estimatedTasks: 2,
      lowCost: 0.1,
      expectedCost: 0.2,
      highCost: 0.4,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      deterministic,
    },
    taskBreakdown: [
      {
        taskId: taskId('T001'),
        taskTitle: 'Local task',
        method: 'local',
        implementerTokens: 1000,
        escalationTokens: 0,
        retryCount: 0,
        cost: 0.01,
        tool: 'ollama',
        model: 'qwen',
        implementerProfile: 'local-small',
        contextFit: 'fits',
        estimatedTokens: 1200,
        contextLength: 32000,
      },
      {
        taskId: taskId('T002'),
        taskTitle: 'Tight task',
        method: 'escalated-full',
        implementerTokens: 1500,
        escalationTokens: 700,
        retryCount: 1,
        costPosture: 'unknown-price',
        tool: 'openrouter',
        model: 'cheap-model',
        implementerProfile: 'cheap-api',
        contextFit: 'tight',
        estimatedTokens: 7000,
        contextLength: 8192,
        routingReason: 'Selected cheapest capable profile cheap-api using conservative context-length fallback',
      },
    ],
  });
  await writeReviewPacket({
    projectDir,
    sessionId: SESSION_ID,
    summary,
    state,
    finalReviewStatus: 'written',
  });
  saveSummary(projectDir, SESSION_ID, makeSession({ id: SESSION_ID, status: 'complete', summary }));
  return projectDir;
}

function readArtifactContents(projectDir: string, files: string[]): Record<string, string> {
  return Object.fromEntries(files.map((file) => [
    file,
    readFileSync(join(sessionDir(projectDir, SESSION_ID), file), 'utf8'),
  ]));
}

describe('buildRunExplain', () => {
  it('explains routing, cost confidence, review gates, warnings, and artifact paths from run artifacts', async () => {
    const projectDir = await writeRichArtifacts();

    const explain = await buildRunExplain({ projectDir, sessionId: SESSION_ID });

    expect(explain.cost.actual).toContain('unknown');
    expect(explain.cost.confidence).toBe('partial');
    expect(explain.cost.unknownPricing).toEqual(expect.arrayContaining([
      'implementer price unknown',
      'T002: price-unknown',
    ]));
    expect(explain.routing.find((route) => route.taskId === 'T002')).toMatchObject({
      selectedProfile: 'cheap-api',
      contextFit: 'tight',
      contextConfidence: 'context-conservative-fallback',
      priceConfidence: 'price-unknown',
    });
    expect(explain.routing.find((route) => route.taskId === 'T002')?.notes).toEqual(expect.arrayContaining([
      'context length used conservative fallback',
      'pricing unknown',
    ]));
    expect(explain.activity.retries).toContainEqual({ taskId: 'T002', retryCount: 1, lastError: 'test failed' });
    expect(explain.activity.escalatedTasks).toContainEqual({ taskId: 'T002', title: 'Tight task', method: 'escalated-full' });
    expect(explain.review.taskReview).toMatchObject({ triggeredCount: 1, taskIds: ['T001'], status: 'triggered' });
    expect(explain.review.finalReview.status).toBe('written');
    expect(explain.warnings.silentReadinessWarnings).toContain('repo.dirty: Repository has local edits before the run.');
    expect(explain.warnings.runtimeWarnings).toContain('warning: context fit was tight');
    expect(explain.artifacts).toContainEqual({
      key: 'reviewPacketJson',
      path: `.diptych/sessions/${SESSION_ID}/${REVIEW_PACKET_JSON_FILE}`,
      present: true,
    });

    const text = formatRunExplain(explain);
    expect(text).toContain('Run explain');
    expect(text).toContain('T002 -> cheap-api');
    expect(text).toContain(`summary: .diptych/sessions/${SESSION_ID}/summary.json`);
  });

  it('handles sessions with missing cost and review packet artifacts', async () => {
    const projectDir = setupSession('explain-missing-cost');
    const state = {
      ...createInitialState('in-progress explain'),
      phase: 'implementing' as const,
      tasks: [makeTask({ id: 'T001', status: 'in_progress' })],
    };
    saveState(projectDir, SESSION_ID, state);
    appendEngineEvent(projectDir, SESSION_ID, {
      type: 'task_started',
      ts: Date.parse('2026-04-29T09:00:00.000Z'),
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Create hello module',
      index: 1,
      total: 1,
      file: 'src/hello.ts',
      action: 'create',
      implementerProfile: 'local-small',
      contextFit: 'fits',
      estimatedTokens: 1000,
    });

    const explain = await buildRunExplain({ projectDir, sessionId: SESSION_ID });

    expect(explain.cost.actual).toBe('unavailable');
    expect(explain.cost.confidence).toBe('unavailable');
    expect(explain.review.finalReview.status).toBe('not-reached');
    expect(explain.routing).toContainEqual(expect.objectContaining({
      taskId: 'T001',
      selectedProfile: 'local-small',
      contextFit: 'fits',
    }));
    expect(explain.artifacts).toContainEqual({
      key: 'reviewPacketJson',
      path: `.diptych/sessions/${SESSION_ID}/${REVIEW_PACKET_JSON_FILE}`,
      present: false,
    });
  });

  it('does not mutate existing session artifacts', async () => {
    const projectDir = await writeRichArtifacts();
    const files = [
      STATE_FILE,
      SESSION_LOG_FILE,
      READINESS_FILE,
      REVIEW_FILE,
      REVIEW_PACKET_JSON_FILE,
      REVIEW_PACKET_MARKDOWN_FILE,
      'summary.json',
    ];
    const before = readArtifactContents(projectDir, files);

    await buildRunExplain({ projectDir, sessionId: SESSION_ID });

    expect(readArtifactContents(projectDir, files)).toEqual(before);
  });
});
