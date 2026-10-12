import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSummary } from './build.js';
import { makeReviewPacket } from '#testing/helpers/factories/review-packet.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { recordLocalTaskEvidence, recordRetryOrEscalationEvidence } from '../evidence/task.js';
import { persistTaskEvidence } from '../evidence/persistence.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
} from '#testing/helpers/orchestrator-task-context.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { transition } from '../../../core/state/machine.js';
import { reviewPacketJsonPath } from '../../../core/paths.js';
import type { ReviewPacket } from '../../../core/schemas/review-packet.js';
import { loadSessionArtifactRollups } from './artifact-rollups.js';

type SummaryState = Parameters<typeof buildSummary>[0]['state'];

function makeState(overrides?: Partial<SummaryState>): SummaryState {
  return {
    tasks: [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'done' }),
      makeTask({ id: 'T003', status: 'done' }),
    ],
    tokenUsage: makeUsage(),
    phase: 'complete',
    currentTaskIndex: 0,
    ...overrides,
  };
}

describe('buildSummary session artifact rollups', () => {
  it('populates evidenceSummary when evidence.json exists', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'summary-test-'));
    try {
      const sessionId = 'test-session-evidence';
      const task = makeTask({ id: 'T001', status: 'done' });
      let ledger = createEvidenceLedger({
        sessionId,
        feature: 'ev-test',
        tasks: [task],
      });
      ledger = recordLocalTaskEvidence({
        ledger,
        task,
        status: 'done',
        method: 'local',
      });
      writeEvidenceLedger({ projectDir, sessionId }, ledger);

      const summary = buildSummary({
        feature: 'ev-test',
        state: makeState(),
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
        projectDir,
        sessionId,
      });

      expect(summary.evidenceSummary).toBeDefined();
      expect(summary.evidenceSummary?.path).toBe('evidence.json');
      expect(summary.evidenceSummary?.totalTasks).toBe(ledger.tasks.length);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('books stoppedAt against the brief at currentTaskIndex, not the first', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'summary-stopped-'));
    try {
      const sessionId = 'stopped-mid-brief';
      const first = makeTask({ id: 'T001', status: 'done' });
      const stopped = makeTask({ id: 'T002', status: 'in_progress' });
      let ledger = createEvidenceLedger({
        sessionId,
        feature: 'stopped',
        tasks: [first, stopped],
      });
      ledger = recordLocalTaskEvidence({
        ledger,
        task: first,
        status: 'done',
        method: 'local',

        changedFiles: ['src/first.ts'],
      });
      ledger = recordLocalTaskEvidence({
        ledger,
        task: stopped,
        status: 'in_progress',

        changedFiles: ['src/stopped.ts'],
      });
      writeEvidenceLedger({ projectDir, sessionId }, ledger);

      const summary = buildSummary({
        feature: 'stopped',
        state: makeState({ tasks: [first, stopped], phase: 'implementing', currentTaskIndex: 1 }),
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
        projectDir,
        sessionId,
      });

      expect(summary.stoppedAt).toEqual({ taskId: 'T002', partialFiles: ['src/stopped.ts'] });
      expect(summary.changedFiles).toEqual(['src/first.ts', 'src/stopped.ts']);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // S11 summary.json: stoppedAt {T005, partialFiles: []} while the ledger booked T005's retried
  // attempts, as failed, with their files.
  it('books the partial files of a brief whose retried attempt the ledger booked failed', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'summary-stopped-failed-'));
    try {
      const sessionId = 'stopped-after-a-failed-attempt';
      const stopped = makeTask({ id: 'T001', suggestedFiles: ['src/stopped.ts'] });
      const ledger = recordRetryOrEscalationEvidence({
        ledger: createEvidenceLedger({ sessionId, feature: 'stopped', tasks: [stopped] }),
        task: stopped,
        status: 'failed',
        method: 'failed',
        retries: 3,
        escalated: false,
        changedFiles: ['src/stopped.ts'],
      });
      writeEvidenceLedger({ projectDir, sessionId }, ledger);

      const summary = buildSummary({
        feature: 'stopped',
        state: makeState({
          tasks: [{ ...stopped, status: 'in_progress' }],
          phase: 'implementing',
          currentTaskIndex: 0,
        }),
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
        projectDir,
        sessionId,
      });

      expect(summary.stoppedAt).toEqual({ taskId: 'T001', partialFiles: ['src/stopped.ts'] });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('books the partial files after the run wrote check results and revised another brief', async () => {
    const wctx = makeTaskWorkflowContext();
    try {
      const first = makeTask({ id: 'T001', title: 'First', suggestedFiles: ['src/first.ts'] });
      const stopped = makeTask({
        id: 'T002',
        title: 'Stopped',
        suggestedFiles: ['src/stopped.ts'],
      });
      let state = transition(makeImplState([first, stopped]), {
        type: 'RECORD_CHECK_RESULTS',
        taskId: first.id,
        results: [{ id: 'K1', status: 'pass' }],
      });
      state = transition(state, { type: 'START_TASK', taskId: stopped.id });
      await persistTaskEvidence({
        wctx,
        state,
        task: stopped,
        recordKind: 'local',
        details: { status: 'in_progress', changedFiles: ['src/stopped.ts'] },
      });
      state = transition(state, {
        type: 'INSERT_TASKS',
        parentId: null,
        tasks: [makeTask({ id: 'T003', title: 'Fix', suggestedFiles: ['src/fix.ts'] })],
      });

      const summary = buildSummary({
        feature: 'stopped',
        state,
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
        projectDir: wctx.projectDir,
        sessionId: wctx.sessionId,
      });

      expect(summary.stoppedAt).toEqual({ taskId: 'T002', partialFiles: ['src/stopped.ts'] });
    } finally {
      cleanupTaskProjects();
    }
  });

  it('keeps earlier files after a real rewind without charging them to the new T001', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'summary-rewound-'));
    try {
      const sessionId = 'rewound-at-plan-gate';
      const oldTask = makeTask({
        id: 'T001',
        title: 'Old brief',
        suggestedFiles: ['src/old.ts'],
        status: 'done',
      });
      const newTask = makeTask({ id: 'T001', title: 'New brief', suggestedFiles: ['src/new.ts'] });
      const ledger = recordLocalTaskEvidence({
        ledger: createEvidenceLedger({
          sessionId,
          feature: 'rewound',
          tasks: [oldTask],
        }),
        task: oldTask,
        status: 'done',
        method: 'local',

        changedFiles: ['src/old.ts'],
      });
      writeEvidenceLedger({ projectDir, sessionId }, ledger);
      const rewound = {
        ...makeImplState([oldTask]),
        phase: 'planning' as const,
        tasks: [],
        rewindPending: { target: 'plan' as const },
      };
      const gate = transition(rewound, { type: 'PLAN_DONE', tasks: [newTask] });
      const base = {
        feature: 'rewound',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
        projectDir,
        sessionId,
      };

      const atGate = buildSummary({ ...base, state: gate });
      expect(atGate.changedFiles).toEqual(['src/old.ts']);
      expect(atGate.stoppedAt).toBeUndefined();
      expect(atGate.totalTasks).toBe(1);
      expect(atGate.completedByLocal).toBe(0);

      const inNewBrief = buildSummary({
        ...base,
        state: transition(transition(gate, { type: 'BEGIN_IMPLEMENTATION' }), {
          type: 'START_TASK',
          taskId: newTask.id,
        }),
      });
      expect(inNewBrief.stoppedAt).toEqual({ taskId: newTask.id, partialFiles: [] });
      expect(inNewBrief.changedFiles).toEqual(['src/old.ts']);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('omits evidenceSummary when no evidence.json exists', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'summary-test-noevid-'));
    try {
      const summary = buildSummary({
        feature: 'no-ev',
        state: makeState(),
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
        projectDir,
        sessionId: 'nonexistent-session',
      });

      expect(summary.evidenceSummary).toBeUndefined();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

function makePacket(finalReview: ReviewPacket['finalReview']): ReviewPacket {
  return makeReviewPacket({ finalReview });
}

function writePacket(projectDir: string, sessionId: string, packet: ReviewPacket): void {
  mkdirSync(join(projectDir, '.splitbrief', 'sessions', sessionId), { recursive: true });
  writeFileSync(
    reviewPacketJsonPath({ projectDir, sessionId }),
    `${JSON.stringify(packet, null, 2)}\n`,
  );
}

describe('review packet rollup final-review fields', () => {
  it('reads a packet an older run saved with a drift score, a chain summary and a retired finding', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'summary-packet-drift-'));
    try {
      const sessionId = 'packet-drift-session';
      const packet = makeReviewPacket();
      const retired = { severity: 'error', code: 'out_of_bounds_text_match', message: 'SECRET.' };
      const olderPacket = {
        ...packet,
        drift: {
          ...packet.drift,
          passed: false,
          score: 0.75,
          findings: [retired],
          findingsBySeverity: { info: [], warning: [], error: [retired] },
          chainSummary: {
            path: 'drift-chains.json',
            present: false,
            emittedChainCount: 0,
            topChain: null,
          },
        },
      };
      mkdirSync(join(projectDir, '.splitbrief', 'sessions', sessionId), { recursive: true });
      writeFileSync(reviewPacketJsonPath({ projectDir, sessionId }), JSON.stringify(olderPacket));

      expect(loadSessionArtifactRollups(projectDir, sessionId).reviewPacket?.driftPassed).toBe(
        false,
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('carries the verdict and finding counts from the packet into the summary rollup', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'summary-packet-verdict-'));
    try {
      const sessionId = 'packet-verdict-session';
      writePacket(
        projectDir,
        sessionId,
        makePacket({
          path: 'review.md',
          status: 'written',
          evidenceStatus: null,
          statusText: 'Reviewer final review written to review.md.',
          excerpt: null,
          verdict: 'fail',
          criteriaPassed: 2,
          criteriaFailed: 1,
          findingCounts: { critical: 1, warning: 0, note: 0 },
        }),
      );

      const rollups = loadSessionArtifactRollups(projectDir, sessionId);

      expect(rollups.reviewPacket?.finalReviewStatus).toBe('written');
      expect(rollups.reviewPacket?.finalReviewVerdict).toBe('fail');
      expect(rollups.reviewPacket?.finalReviewFindingCounts).toEqual({
        critical: 1,
        warning: 0,
        note: 0,
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('yields a null verdict and zero counts for a packet without the final-review verdict fields', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'summary-packet-legacy-'));
    try {
      const sessionId = 'packet-legacy-session';
      const packet = makePacket({
        path: 'review.md',
        status: 'written',
        evidenceStatus: null,
        statusText: 'Planner final review written to review.md.',
        excerpt: null,
        verdict: 'pass',
        criteriaPassed: 0,
        criteriaFailed: 0,
        findingCounts: { critical: 0, warning: 0, note: 0 },
      });
      const legacyPacket = {
        ...packet,
        finalReview: {
          path: packet.finalReview.path,
          status: packet.finalReview.status,
          evidenceStatus: packet.finalReview.evidenceStatus,
          statusText: packet.finalReview.statusText,
          excerpt: packet.finalReview.excerpt,
        },
      };
      mkdirSync(join(projectDir, '.splitbrief', 'sessions', sessionId), { recursive: true });
      writeFileSync(
        reviewPacketJsonPath({ projectDir, sessionId }),
        `${JSON.stringify(legacyPacket)}\n`,
      );

      const rollups = loadSessionArtifactRollups(projectDir, sessionId);

      expect(rollups.reviewPacket).toBeDefined();
      expect(rollups.reviewPacket?.finalReviewVerdict).toBeNull();
      expect(rollups.reviewPacket?.finalReviewFindingCounts).toEqual({
        critical: 0,
        warning: 0,
        note: 0,
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
