import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  makePassingPlanner,
  makePassingTask,
  runOwnedPlanningPhase,
  setupProject,
} from '#testing/helpers/planning-phase.js';
import { readWorkflowStateHead } from '../state-ops.js';
import { persistBriefOwnerTransition } from '../evidence/persistence.js';
import { createBriefRecoveryState } from './brief-recovery.js';
import { planningResultForState, matchesPersistedExecutionPermit } from './handoff.js';
import { resolveOwnerReadiness } from './io.js';
import { issueApprovedGenerationPermit } from './briefs-approval-queue.js';
import type {
  BriefGenerationRef,
  BriefOwnerCommitPort,
} from '../../../core/schemas/brief-owner.js';
import { sha256Hex } from '../../../utils/sha256.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs.length = 0;
});

const DISPOSITIONS = ['ready-for-tasks', 'parked', 'terminal'] as const;

function approveCallbacks() {
  const { callbacks } = makeCallbacks({
    onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),
  });
  return callbacks;
}

describe('cross-mode disposition contract', () => {
  it.each([
    ['instant', { mode: 'instant' }],
    ['quick', { mode: 'quick' }],
    ['standard', { mode: 'standard' }],
    ['speckit', { mode: 'speckit' }],
  ] as const)('%s mode returns exactly one explicit disposition', async (_label, workflow) => {
    const { result, projectDir, sessionId } = await runOwnedPlanningPhase(dirs, {
      planner: makePassingPlanner(),
      callbacks: approveCallbacks(),
      config: makeConfig({ workflow }),
    });

    expect(DISPOSITIONS).toContain(result.disposition);
    if (result.disposition === 'ready-for-tasks') {
      const readiness = resolveOwnerReadiness({ projectDir, sessionId });
      expect(readiness.ok).toBe(true);
      if (readiness.ok) {
        expect(result.generation).toEqual(readiness.generation);
        expect(result.permit).toEqual(readiness.permit);
        expect(result.permit.authorityRevision).toBe(readiness.authorityRevision);
      }
    }
  });

  it('readiness is never derived from phase, task count, or the absence of failure flags', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    const { state } = readyImplementingHead(ref);

    const result = planningResultForState({ sessionId, state, tasks: state.tasks });

    expect(result).toMatchObject({ disposition: 'parked' });
    expect(state.phase).toBe('implementing');
    expect(state.tasks.length).toBeGreaterThan(0);
    expect(resolveOwnerReadiness(ref)).toMatchObject({ ok: false, reason: 'no-generation' });
  });

  it('ready-for-tasks holds only while the committed permit matches the current generation', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    const fixture = readyImplementingHead(ref);
    const { state, generation, qualityDigest } = fixture;
    const { bus } = makeBusRecorder();
    const commit: BriefOwnerCommitPort = (input) =>
      persistBriefOwnerTransition({ ...input, ref, bus });
    const headState = (): WorkflowState => {
      const head = readWorkflowStateHead(ref);
      if (head === null) throw new Error('expected a persisted head');
      return head.state;
    };

    const parked = planningResultForState({ sessionId, state, tasks: state.tasks });
    expect(parked).toMatchObject({ disposition: 'parked' });

    const issued = issueApprovedGenerationPermit({
      ref,
      epochId: 'epoch-1',
      authorityRevision: 1,
      generation,
      qualityDigest,
      commit,
    });
    expect(issued).toMatchObject({ kind: 'issued' });
    if (issued.kind !== 'issued') return;

    const ready = planningResultForState({ sessionId, state: headState(), tasks: state.tasks });
    expect(ready).toMatchObject({ disposition: 'ready-for-tasks' });
    if (ready.disposition !== 'ready-for-tasks') return;
    expect(ready.generation).toEqual(generation);
    expect(ready.permit).toEqual(issued.permit);
    expect(ready.permit.authorityRevision).toBe(2);
    expect(matchesPersistedExecutionPermit(ready, headState())).toBe(true);
    expect(resolveOwnerReadiness(ref)).toMatchObject({ ok: true });

    const replacement = {
      ...generation,
      generationId: `generation-replacement-${sha256Hex('replacement').slice(0, 16)}`,
      tasksDigest: sha256Hex('replacement-tasks'),
    };
    const head = readWorkflowStateHead(ref);
    const recovery = head?.state.briefRecovery;
    if (head === null || recovery === null || recovery === undefined) {
      throw new Error('expected a ready recovery head');
    }
    const parkEvent = {
      type: 'brief_recovery_refused',
      ts: 0,
      phase: 'reviewing-briefs',
      version: 1,
      eventId: 'replacement-park',
      sessionId,
      epochId: 'epoch-1',
      recoveryRevision: 1,
      briefRevision: 1,
      briefHash: sha256Hex('brief'),
      reportRevision: null,
      reportHash: null,
      intentId: 'replacement-intent',
      operationId: 'replacement-operation',
      action: 'reject',
      refusalCategory: 'quality',
      refusalCode: 'brief_replacement_generation',
      status: 'ready',
    } as const;
    const replaced = persistBriefOwnerTransition({
      ref,
      expected: {
        epochId: 'epoch-1',
        stateRevision: head.revision,
        authorityRevision: head.state.authorityRevision ?? 0,
        fence: String(head.state.stateFence?.token ?? 0),
        evidenceHead: recovery.evidenceHead,
      },
      operationId: 'replacement-operation',
      evidence: { epochId: 'epoch-1', kind: 'rejection', payload: parkEvent },
      event: parkEvent,
      projectNext: ({ current }) => ({
        disposition: 'parked',
        authorityRevision: (head.state.authorityRevision ?? 0) + 1,
        generation: replacement,
        permit: null,
        recovery: current,
      }),
      bus,
    });
    expect(replaced.kind).toBe('committed');

    const afterReplacement = planningResultForState({
      sessionId,
      state: headState(),
      tasks: state.tasks,
    });
    expect(afterReplacement).toMatchObject({ disposition: 'parked' });
    expect(headState().generation).toEqual(replacement);
    expect(headState().permit).toBeNull();
    expect(resolveOwnerReadiness(ref)).toMatchObject({ ok: false, reason: 'no-permit' });
  });

  it('a rewind or recovery epoch without a permit stays parked even with a committed generation', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    const { state, generation } = readyImplementingHead(ref, { commitGeneration: true });

    const result = planningResultForState({ sessionId, state, tasks: state.tasks });

    expect(result).toMatchObject({ disposition: 'parked' });
    expect(state.generation).toEqual(generation);
    expect(resolveOwnerReadiness(ref)).toMatchObject({ ok: false, reason: 'no-permit' });
  });
});

function readyImplementingHead(
  ref: { projectDir: string; sessionId: string },
  options: { commitGeneration?: boolean } = {},
): {
  state: WorkflowState;
  generation: BriefGenerationRef;
  qualityDigest: string;
} {
  const activeBrief = { revision: 1, hash: sha256Hex('brief'), path: 'tasks.md' };
  const qualityDigest = sha256Hex('quality');
  const generation: BriefGenerationRef = {
    generationId: `generation-${sha256Hex('approved').slice(0, 16)}`,
    manifestDigest: sha256Hex('manifest'),
    tasksDigest: sha256Hex('tasks'),
    qualityDigest,
    programId: null,
  };
  const recovery = createBriefRecoveryState(
    {
      sessionId: ref.sessionId,
      origin: { mode: 'standard', entry: 'initial' },
      continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
      activeBrief,
      report: {
        briefHash: activeBrief.hash,
        report: { revision: 1, hash: qualityDigest, path: 'brief-quality.json' },
        ruleVersion: 'brief-quality-v1',
        issues: [],
        errorCount: 0,
      },
      qualityPolicyVersion: 'brief-quality-v1',
    },
    { epochId: 'epoch-1' },
  );
  const state: WorkflowState = {
    ...createInitialState('disposition-feature'),
    phase: 'implementing',
    tasks: [makePassingTask()],
    stateFence: { token: 1, ownerId: 'disposition-owner' },
    authorityRevision: 1,
    briefRecovery: recovery,
    ...(options.commitGeneration ? { generation } : {}),
  };
  saveState(ref, state);
  return { state, generation, qualityDigest };
}
