import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSummary } from './build.js';
import type { BuildSummaryState } from './build.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeReviewPacket } from '#testing/helpers/factories/review-packet.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { recordLocalTaskEvidence } from '../evidence/task.js';
import { writeDriftChainState } from '../drift/chain-state.js';
import type { DriftChainState } from '../../../core/schemas/drift-chain.js';
import { reviewPacketJsonPath } from '../../../core/paths.js';
import type { ReviewPacket } from '../../../core/schemas/review-packet.js';
import { loadSessionArtifactRollups } from './artifact-rollups.js';

function makeState(overrides?: Partial<BuildSummaryState>): BuildSummaryState {
  return {
    tasks: [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'done' }),
      makeTask({ id: 'T003', status: 'done' }),
    ],
    tokenUsage: makeUsage(),
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
        mode: 'standard',
        tasks: [task],
      });
      ledger = recordLocalTaskEvidence({
        ledger,
        task,
        status: 'done',
        method: 'local',
        validation: [{ passed: true, stage: 'typecheck' }],
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

  it('chainDriftSummary is undefined when no drift-chains.json on disk', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'summary-chain-nofile-'));
    try {
      const summary = buildSummary({
        feature: 'no-chain',
        state: makeState(),
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
        projectDir,
        sessionId: 'nonexistent-chain-session',
      });
      expect(summary.chainDriftSummary).toBeUndefined();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('chainDriftSummary is undefined when drift-chains.json has zero emitted chains', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'summary-chain-empty-'));
    try {
      const sessionId = 'chain-empty-session';
      const state: DriftChainState = {
        version: 1,
        sessionId,
        activeChain: { entries: [], uniqueFiles: [], score: 0 },
        emittedChains: [],
      };
      writeDriftChainState({ projectDir, sessionId }, state);
      const summary = buildSummary({
        feature: 'chain-empty',
        state: makeState(),
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
        projectDir,
        sessionId,
      });
      expect(summary.chainDriftSummary).toBeUndefined();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('chainDriftSummary reflects single emitted chain', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'summary-chain-one-'));
    try {
      const sessionId = 'chain-one-session';
      const chainState: DriftChainState = {
        version: 1,
        sessionId,
        activeChain: { entries: [], uniqueFiles: [], score: 0 },
        emittedChains: [
          {
            chainLength: 4,
            score: 0.8,
            uniqueOutOfBoundsFiles: ['src/foo.ts', 'src/bar.ts'],
            representativePath: 'src/foo.ts',
            detectedAtTaskId: taskId('T004'),
          },
        ],
      };
      writeDriftChainState({ projectDir, sessionId }, chainState);
      const summary = buildSummary({
        feature: 'chain-one',
        state: makeState(),
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
        projectDir,
        sessionId,
      });
      expect(summary.chainDriftSummary).toBeDefined();
      expect(summary.chainDriftSummary?.score).toBe(0.8);
      expect(summary.chainDriftSummary?.chainLength).toBe(4);
      expect(summary.chainDriftSummary?.representativePath).toBe('src/foo.ts');
      expect(summary.chainDriftSummary?.emittedChainCount).toBe(1);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('chainDriftSummary reflects highest-scoring chain when multiple emitted', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'summary-chain-multi-'));
    try {
      const sessionId = 'chain-multi-session';
      const chainState: DriftChainState = {
        version: 1,
        sessionId,
        activeChain: { entries: [], uniqueFiles: [], score: 0 },
        emittedChains: [
          {
            chainLength: 2,
            score: 0.5,
            uniqueOutOfBoundsFiles: ['src/a.ts'],
            representativePath: 'src/a.ts',
            detectedAtTaskId: taskId('T002'),
          },
          {
            chainLength: 5,
            score: 0.9,
            uniqueOutOfBoundsFiles: ['src/b.ts', 'src/c.ts'],
            representativePath: 'src/b.ts',
            detectedAtTaskId: taskId('T007'),
          },
        ],
      };
      writeDriftChainState({ projectDir, sessionId }, chainState);
      const summary = buildSummary({
        feature: 'chain-multi',
        state: makeState(),
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
        projectDir,
        sessionId,
      });
      expect(summary.chainDriftSummary).toBeDefined();
      expect(summary.chainDriftSummary?.score).toBe(0.9);
      expect(summary.chainDriftSummary?.chainLength).toBe(5);
      expect(summary.chainDriftSummary?.representativePath).toBe('src/b.ts');
      expect(summary.chainDriftSummary?.emittedChainCount).toBe(2);
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
          statusText: 'Planner final review written to review.md.',
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
