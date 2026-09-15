import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  auto,
  prepareState,
  runPlanningTurn as runPhaseHelper,
  makePassingTask,
  makePassingPlanner,
  type RunOpts,
} from '#testing/helpers/planning-phase.js';
import { loadState } from '../../../core/state/persistence.js';
import {
  createPlannerArtifactAttemptId,
  OwnedPlannerArtifactSchema,
} from '../../../core/schemas/planner-artifact.js';
import { makePhaseCallResult } from '#testing/helpers/factories/phase-call.js';
import type {
  PhaseCallResult,
  PhaseResult,
  PlannerArtifactLogicalName,
  PlannerDocumentCall,
  RunPhaseInput,
} from '../../planners/types.js';
import { sha256Hex } from '../../../utils/sha256.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function runPhase(opts: RunOpts = {}) {
  return runPhaseHelper(dirs, opts);
}

function phaseResult(
  logicalName: PlannerArtifactLogicalName,
  text: string,
  rawOutput: string,
): PhaseResult {
  const digest = sha256Hex(text);
  return {
    artifact: OwnedPlannerArtifactSchema.parse({
      semanticId: `test-${logicalName}`,
      programId: null,
      batchId: null,
      attemptId: createPlannerArtifactAttemptId(),
      logicalName,
      transport: 'stdout-final',
      text,
      byteLength: Buffer.byteLength(text, 'utf8'),
      sha256: digest,
      runtimeReceipt: digest,
      terminal: { status: 'completed', recordId: `test-${logicalName}`, protocolDigest: digest },
      sourceReceipt: { kind: 'stdout-final', resultDigest: digest },
    }),
    rawOutput,
  };
}

describe('runPlanningPhase — mode persistence', () => {
  it('stamps the resolved mode and approve level onto persisted state', async () => {
    const config = makeConfig({ workflow: { ...auto('speckit') } });
    const { projectDir, sessionId } = await runPhase({ config });

    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.mode).toBe('speckit');
    expect(persisted?.approve).toBe('none');
  });

  it('reuses a saved mode over the current config default', async () => {
    const config = makeConfig({ workflow: { ...auto('standard') } });
    const pinned = { ...prepareState(), mode: 'speckit' as const };
    const { projectDir, sessionId } = await runPhase({ config, state: pinned });

    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.mode).toBe('speckit');
  });
});

describe('runPlanningPhase — persistence', () => {
  it('writes artifact text (not raw stdout) to disk', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { sessionDir, SPEC_FILE, PLAN_FILE } = await import('../../../core/paths.js');
    const { join } = await import('node:path');

    const artifactSpec = '# Resolved Spec\n\nAdd authentication.\n';
    const artifactPlan = '# Resolved Plan\n\nUse JWT.\n';
    const ARTIFACT_TEXT: Partial<Record<PlannerDocumentCall, string>> = {
      spec: artifactSpec,
      plan: artifactPlan,
    };
    const runPhaseMock = vi.fn(async ({ call }: RunPhaseInput): Promise<PhaseCallResult> => {
      const text = ARTIFACT_TEXT[call];
      if (text === undefined) return makePhaseCallResult({ call, tasks: [makePassingTask()] });
      return {
        text,
        usage: { inputTokens: 100, outputTokens: 50 },
        artifact: phaseResult(
          call === 'spec' ? SPEC_FILE : PLAN_FILE,
          text,
          `raw planner noise for ${call}`,
        ),
      };
    });

    const { projectDir, sessionId } = await runPhase({
      planner: makePassingPlanner({ runPhase: runPhaseMock }),
      config: makeConfig({ workflow: auto() }),
    });

    const specPath = join(sessionDir(projectDir, sessionId), SPEC_FILE);
    const planPath = join(sessionDir(projectDir, sessionId), PLAN_FILE);
    expect(existsSync(specPath)).toBe(true);
    expect(existsSync(planPath)).toBe(true);
    expect(readFileSync(specPath, 'utf-8')).toContain('Add authentication');
    expect(readFileSync(specPath, 'utf-8')).not.toContain('raw planner noise');
    expect(readFileSync(planPath, 'utf-8')).toContain('Use JWT');
    expect(readFileSync(planPath, 'utf-8')).not.toContain('raw planner noise');
  });
});
