import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createEvidenceLedger, withUpdatedTask } from '../../core/evidence/ledger-state.js';
import { seatSupportsImages } from '../../core/runners/capabilities.js';
import { deriveReviewOutcome, verificationKey } from '../../core/review/verdict.js';
import { taskId, type Check } from '../../core/schemas/task.js';
import type { EvidenceCheckEntry, EvidenceLedger } from '../../core/schemas/evidence.js';
import type { ReviewVerdict } from '../../core/schemas/review.js';
import { buildFinalReviewPrompt } from '../spec/prompts/review.js';
import {
  MAX_REVIEW_RENDER_IMAGES,
  NO_VISION_REVIEW,
  forceUnverifiedRenderCriteria,
  reviewRenders,
} from './review-renders.js';

const RENDER_A = 'chk-dashboard';
const RENDER_B = 'chk-settings';
const CANDIDATE = 'candidate-current';

function renderCheck(id: string, value: string): Check {
  return { id, kind: 'render', value, required: true };
}

function registryOf(...checks: Check[]): ReadonlyMap<string, Check> {
  return new Map(checks.map((check) => [check.id, check]));
}

function checkEntry(
  id: string,
  paths: readonly string[],
  workspaceSnapshotId = CANDIDATE,
): EvidenceCheckEntry {
  return {
    id,
    artifacts: paths.map((path) => ({ path, sha256: 'a'.repeat(64) })),
    workspaceSnapshotId,
    ts: 'ts',
  };
}

function ledgerWithChecks(checks: readonly EvidenceCheckEntry[]): EvidenceLedger {
  const ledger = createEvidenceLedger({
    sessionId: 'session-1',
    feature: 'feature',
    tasks: [makeTask({ status: 'done' })],
  });
  return withUpdatedTask(ledger, 'T001', (task) => ({ ...task, checks: [...checks] }));
}

function writePng(path: string): void {
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function passVerdict(): ReviewVerdict {
  return {
    tasks: [{ id: taskId('T001'), plan: 'met', note: '' }],
    criteria: [
      { id: 'C1', status: 'pass', evidence: '' },
      { id: 'C2', status: 'pass', evidence: '' },
    ],
    findings: [],
  };
}

describe('reviewRenders', () => {
  it('attaches a render PNG when the seat takes images', () => {
    const projectDir = createTempDir('review-renders');
    const png = join(projectDir, 'dashboard.png');
    writePng(png);

    const renders = reviewRenders({
      ledger: ledgerWithChecks([checkEntry(RENDER_A, [png])]),
      registry: registryOf(renderCheck(RENDER_A, 'dashboard')),
      projectDir,
      currentCandidateId: CANDIDATE,
      seatSupportsImages: true,
    });

    expect(renders.attachedCheckIds).toEqual([RENDER_A]);
    expect(renders.missingCheckIds).toEqual([]);
    expect(renders.images).toHaveLength(1);
    expect(renders.images[0]?.path.endsWith('dashboard.png')).toBe(true);
    expect(renders.section).toContain(png);
    expect(renders.section).not.toContain(NO_VISION_REVIEW);
    const prompt = buildFinalReviewPrompt({
      spec: 'spec',
      taskBriefs: 'briefs',
      renders: renders.section,
    });
    expect(prompt).toContain('## Renders');
    expect(prompt).toContain(png);
    expect(prompt).not.toContain('Never claim a render was verified.');
    expect(prompt).toContain(
      'Verify a render only when its current-candidate images are attached and you critique the scenario.',
    );
    expect(prompt).toContain('Write one critique per rendered scenario');
  });

  it('forces only the criterion whose render check has no image', () => {
    const projectDir = createTempDir('review-renders');
    const png = join(projectDir, 'dashboard.png');
    writePng(png);

    const renders = reviewRenders({
      ledger: ledgerWithChecks([checkEntry(RENDER_A, [png])]),
      registry: registryOf(renderCheck(RENDER_A, 'dashboard'), renderCheck(RENDER_B, 'settings')),
      projectDir,
      currentCandidateId: CANDIDATE,
      seatSupportsImages: true,
    });

    expect(renders.attachedCheckIds).toEqual([RENDER_A]);
    expect(renders.missingCheckIds).toEqual([RENDER_B]);
    expect(renders.images).toHaveLength(1);
    expect(renders.section).toContain('settings');
    expect(renders.section).toContain('no image produced');
    expect(renders.section).toContain(NO_VISION_REVIEW);

    const verification: Map<string, 'pass' | 'fail' | 'unverified'> = new Map([
      [verificationKey('criterion', 'C1'), 'pass'],
      [verificationKey('criterion', 'C2'), 'pass'],
    ]);
    const forced = forceUnverifiedRenderCriteria({
      verdict: passVerdict(),
      renderCheckIds: renders.missingCheckIds,
      criterionCheckIds: (criterionId) => (criterionId === 'C2' ? [RENDER_B] : [RENDER_A]),
      verification,
    });

    expect(forced.forcedCriterionIds).toEqual(['C2']);
    expect(forced.verdict.criteria[0]?.status).toBe('pass');
    expect(forced.verdict.criteria[1]?.status).toBe('unverified');
    const outcome = deriveReviewOutcome(
      forced.verdict,
      { taskIds: ['T001'], criterionIds: ['C1', 'C2'] },
      verification,
    );
    expect(outcome.kind).not.toBe('pass');
    expect(outcome.unverifiedCriteria).toEqual(['C2']);
  });

  it('states the no-vision sentence when registered render checks produced no image', () => {
    const projectDir = createTempDir('review-renders');

    const renders = reviewRenders({
      ledger: ledgerWithChecks([]),
      registry: registryOf(renderCheck(RENDER_A, 'dashboard')),
      projectDir,
      currentCandidateId: CANDIDATE,
      seatSupportsImages: true,
    });

    expect(renders.attachedCheckIds).toEqual([]);
    expect(renders.missingCheckIds).toEqual([RENDER_A]);
    expect(renders.images).toEqual([]);
    expect(renders.section).toBeDefined();
    expect(renders.section).toContain('dashboard');
    expect(renders.section).toContain('no image produced');
    expect(renders.section).toContain(NO_VISION_REVIEW);
  });

  it('hands a seat without images a manifest and leaves its render criterion unverified', () => {
    const projectDir = createTempDir('review-renders');
    const png = join(projectDir, 'dashboard.png');
    writePng(png);
    const takesImages = seatSupportsImages({ runner: { kind: 'cli', tool: 'opencode' } });
    expect(takesImages).toBe(false);

    const renders = reviewRenders({
      ledger: ledgerWithChecks([checkEntry(RENDER_A, [png])]),
      registry: registryOf(renderCheck(RENDER_A, 'dashboard')),
      projectDir,
      currentCandidateId: CANDIDATE,
      seatSupportsImages: takesImages,
    });

    expect(renders.attachedCheckIds).toEqual([]);
    expect(renders.missingCheckIds).toEqual([RENDER_A]);
    expect(renders.images).toEqual([]);
    expect(renders.section).toContain(png);
    expect(renders.section).toContain(NO_VISION_REVIEW);

    const prompt = buildFinalReviewPrompt({
      spec: 'spec',
      taskBriefs: 'briefs',
      renders: renders.section,
    });
    expect(prompt).toContain('Rendered scenarios (not attached):');
    expect(prompt).toContain(NO_VISION_REVIEW);
    expect(prompt).toContain(
      'Verify a render only when its current-candidate images are attached and you critique the scenario.',
    );
    expect(prompt).not.toContain('Never claim a render was verified.');

    const verification: Map<string, 'pass' | 'fail' | 'unverified'> = new Map([
      [verificationKey('criterion', 'C1'), 'pass'],
    ]);
    const forced = forceUnverifiedRenderCriteria({
      verdict: passVerdict(),
      renderCheckIds: renders.missingCheckIds,
      criterionCheckIds: (criterionId) => (criterionId === 'C1' ? [RENDER_A] : []),
      verification,
    });

    expect(forced.forcedCriterionIds).toEqual(['C1']);
  });

  it('falls back to the manifest when more renders than the cap were recorded', () => {
    const projectDir = createTempDir('review-renders');
    const paths = Array.from({ length: MAX_REVIEW_RENDER_IMAGES + 1 }, (_value, index) => {
      const png = join(projectDir, `dashboard-${index}.png`);
      writePng(png);
      return png;
    });

    const renders = reviewRenders({
      ledger: ledgerWithChecks([checkEntry(RENDER_A, paths)]),
      registry: registryOf(renderCheck(RENDER_A, 'dashboard')),
      projectDir,
      currentCandidateId: CANDIDATE,
      seatSupportsImages: true,
    });

    expect(renders.artifacts).toHaveLength(MAX_REVIEW_RENDER_IMAGES + 1);
    expect(renders.attachedCheckIds).toEqual([]);
    expect(renders.missingCheckIds).toEqual([RENDER_A]);
    expect(renders.section).toContain(NO_VISION_REVIEW);
  });

  it('ignores an older candidate PNG when the current candidate produced none', () => {
    const projectDir = createTempDir('review-renders');
    const png = join(projectDir, 'dashboard.png');
    writePng(png);

    const renders = reviewRenders({
      ledger: ledgerWithChecks([
        checkEntry(RENDER_A, [png], 'candidate-old'),
        checkEntry(RENDER_A, [], CANDIDATE),
      ]),
      registry: registryOf(renderCheck(RENDER_A, 'dashboard')),
      projectDir,
      currentCandidateId: CANDIDATE,
      seatSupportsImages: true,
    });

    expect(renders.artifacts).toEqual([]);
    expect(renders.attachedCheckIds).toEqual([]);
    expect(renders.missingCheckIds).toEqual([RENDER_A]);
    expect(renders.images).toEqual([]);
    expect(renders.section).toContain('no image produced');
    expect(renders.section).toContain(NO_VISION_REVIEW);

    const verification: Map<string, 'pass' | 'fail' | 'unverified'> = new Map([
      [verificationKey('criterion', 'C1'), 'pass'],
    ]);
    const forced = forceUnverifiedRenderCriteria({
      verdict: passVerdict(),
      renderCheckIds: renders.missingCheckIds,
      criterionCheckIds: (criterionId) => (criterionId === 'C1' ? [RENDER_A] : []),
      verification,
    });

    expect(forced.forcedCriterionIds).toEqual(['C1']);
    expect(forced.verdict.criteria[0]?.status).toBe('unverified');
  });

  it('judges a render check on its latest execution even when an earlier task holds an older PNG', () => {
    const projectDir = createTempDir('review-renders');
    const png = join(projectDir, 'dashboard.png');
    writePng(png);
    // The pre-review records on the last task and other verification on the first,
    // so ledger order says nothing about which execution came last.
    const base = createEvidenceLedger({
      sessionId: 'session-1',
      feature: 'feature',
      tasks: [makeTask({ id: 'T001', status: 'done' }), makeTask({ id: 'T002', status: 'done' })],
    });
    const newer = { ...checkEntry(RENDER_A, []), ts: '2026-10-06T02:00:00.000Z' };
    const older = { ...checkEntry(RENDER_A, [png]), ts: '2026-10-06T01:00:00.000Z' };
    const ledger = withUpdatedTask(
      withUpdatedTask(base, 'T001', (task) => ({ ...task, checks: [newer] })),
      'T002',
      (task) => ({ ...task, checks: [older] }),
    );

    const renders = reviewRenders({
      ledger,
      registry: registryOf(renderCheck(RENDER_A, 'dashboard')),
      projectDir,
      currentCandidateId: CANDIDATE,
      seatSupportsImages: true,
    });

    expect(renders.attachedCheckIds).toEqual([]);
    expect(renders.missingCheckIds).toEqual([RENDER_A]);
    expect(renders.images).toEqual([]);
  });

  it('treats a render check with no entry for the current candidate as missing', () => {
    const projectDir = createTempDir('review-renders');
    const png = join(projectDir, 'dashboard.png');
    writePng(png);

    const renders = reviewRenders({
      ledger: ledgerWithChecks([checkEntry(RENDER_A, [png], 'candidate-old')]),
      registry: registryOf(renderCheck(RENDER_A, 'dashboard')),
      projectDir,
      currentCandidateId: CANDIDATE,
      seatSupportsImages: true,
    });

    expect(renders.attachedCheckIds).toEqual([]);
    expect(renders.missingCheckIds).toEqual([RENDER_A]);
    expect(renders.section).toContain(NO_VISION_REVIEW);
  });
});
