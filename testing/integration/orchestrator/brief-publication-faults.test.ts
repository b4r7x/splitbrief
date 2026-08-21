import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { WorkflowStateSchema, type WorkflowState } from '../../../src/core/schemas/workflow.js';
import { BRIEF_QUALITY_FILE, STATE_FILE, TASKS_FILE, sessionDir } from '../../../src/core/paths.js';
import { readSpecFile } from '../../../src/core/paths-io.js';
import type { StateAuthorityReceipt } from '../../../src/core/state/types.js';
import type { SessionRef } from '../../../src/core/types/session-ref.js';
import type {
  BriefGenerationRef,
  BriefOwnerCommitInput,
  BriefOwnerCommitPort,
  BriefOwnerCommitResult,
  BriefOwnerEvent,
  TaskExecutionPermit,
} from '../../../src/core/schemas/brief-owner.js';
import type { NormalBriefRecoveryV1 } from '../../../src/core/schemas/brief-recovery.js';
import {
  readWorkflowStateHead,
  revisionsMatch,
  workflowStateRevision,
} from '../../../src/engine/orchestrator/state-ops.js';
import { createWorkflowRecoveryBinding } from '../../../src/engine/orchestrator/run/recovery-binding.js';
import {
  drainRecoveryOutbox,
  persistBriefOwnerTransition,
  type RecoveryFaultPoint,
} from '../../../src/engine/orchestrator/evidence/persistence.js';
import { readRecoveryJournal } from '../../../src/core/evidence/ledger-storage.js';
import {
  publishBriefGeneration,
  type BriefPublicationOptions,
} from '../../../src/engine/orchestrator/planning/brief-publication.js';
import {
  issueApprovedGenerationPermit,
  type ApprovedGenerationPermitOptions,
} from '../../../src/engine/orchestrator/planning/briefs-approval-queue.js';
import { resolveOwnerReadiness } from '../../../src/engine/orchestrator/planning/io.js';
import { planningResultForState } from '../../../src/engine/orchestrator/planning/handoff.js';
import {
  buildBriefGenerationIdentity,
  observeGenerationStorage,
  type BriefGenerationCandidate,
} from '../../../src/engine/orchestrator/planning/brief-generation.js';
import type { Planner } from '../../../src/engine/planners/types.js';
import type { ModelCacheAccessor } from '../../../src/engine/providers/model/resolution.js';
import type { EventBus } from '../../../src/engine/events/types.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { makeBusRecorder, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { sha256Hex } from '../../../src/utils/sha256.js';
import { canonicalJSON } from '../../../src/utils/canonical-json.js';
import { evaluateBriefQuality } from '../../../src/engine/spec/brief-quality.js';
import { parseTasksStrict } from '../../../src/engine/spec/tasks/parse.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  makeBriefQualityFailureTask,
  makePassingPlanner,
  makePassingTask,
  REAL_TASKS_MD,
  setupProject,
  TEST_METADATA,
} from '#testing/helpers/planning-phase.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) cleanupTempDir(dir);
  }
});

const PRICED_MODEL_CACHE = {
  getModelsDevCatalog: () => ({
    openai: {
      id: 'openai',
      models: {
        'gpt-5.4': {
          id: 'gpt-5.4',
          cost: { input: 2.5, output: 15 },
          limit: { context: 400_000 },
        },
      },
    },
  }),
  getProviderModels: () => null,
};

const NOW = '2026-08-14T00:00:00.000Z';
const TS = 1_752_000_000_000;

function stateBytes(ref: SessionRef): string {
  return readFileSync(join(sessionDir(ref.projectDir, ref.sessionId), STATE_FILE), 'utf8');
}

function authorityFor(
  state: WorkflowState,
  digest: string,
  sessionId: string,
): StateAuthorityReceipt {
  return {
    kind: 'usable',
    sessionId,
    ownerId: state.stateFence?.ownerId ?? 'publication-matrix',
    pid: process.pid,
    processStart: 'publication-matrix-process',
    runId: 'publication-matrix-run',
    acquisitionId: 'publication-matrix-acquisition',
    fence: state.stateFence?.token ?? 0,
    stateRevision: workflowStateRevision(state),
    stateDigest: digest,
  };
}

type BindingFixture = {
  binding: ReturnType<typeof createWorkflowRecoveryBinding>;
  ref: SessionRef;
  authority: () => StateAuthorityReceipt;
  trackedState: () => WorkflowState;
};

function seedState(ref: SessionRef, mode?: WorkflowState['mode']): WorkflowState {
  const state: WorkflowState = {
    ...createInitialState('publication-matrix'),
    stateFence: { token: 1, ownerId: 'publication-matrix' },
    ...(mode === undefined ? {} : { mode }),
  };
  saveState(ref, state);
  return state;
}

function makeBinding(
  ref: SessionRef,
  options: {
    planner?: Planner | undefined;
    modelCache?: ModelCacheAccessor | undefined;
    maxBudget?: number | undefined;
    model?: string | undefined;
  } = {},
): BindingFixture {
  const initialHead = readWorkflowStateHead(ref);
  if (initialHead === null) throw new Error('expected the initial workflow head');
  const wctx = makeWctx({
    projectDir: ref.projectDir,
    sessionId: ref.sessionId,
    config: makeConfig({
      planner: {
        kind: 'api',
        provider: 'openai',
        service: 'openai',
        offering: 'payg',
        apiBase: 'https://api.openai.com/v1',
        model: options.model ?? 'gpt-5.4',
      },
      workflow: {
        ...(options.maxBudget === undefined ? {} : { maxBudget: options.maxBudget }),
      },
    }),
    planner: options.planner ?? makePassingPlanner(),
    ...(options.modelCache === undefined ? {} : { modelCache: options.modelCache }),
    metadata: TEST_METADATA,
  });
  let trackedState: WorkflowState = initialHead.state;
  let authority = authorityFor(initialHead.state, initialHead.digest, ref.sessionId);
  const binding = createWorkflowRecoveryBinding({
    wctx,
    getState: () => trackedState,
    setState: (next) => {
      trackedState = next;
      const head = readWorkflowStateHead(ref);
      if (head === null) throw new Error('expected the committed workflow head');
      authority = {
        ...authority,
        stateRevision: workflowStateRevision(next),
        stateDigest: head.digest,
      };
    },
    getAuthority: () => authority,
  });
  return { binding, ref, authority: () => authority, trackedState: () => trackedState };
}

function fixture(
  options: {
    planner?: Planner | undefined;
    modelCache?: ModelCacheAccessor | undefined;
    maxBudget?: number | undefined;
    mode?: WorkflowState['mode'] | undefined;
    model?: string | undefined;
  } = {},
): BindingFixture {
  const { projectDir, sessionId } = setupProject(dirs);
  const ref = { projectDir, sessionId };
  seedState(ref, options.mode);
  return makeBinding(ref, options);
}

function normalRecovery(state: WorkflowState): NormalBriefRecoveryV1 {
  const recovery = state.briefRecovery;
  if (recovery === null || recovery === undefined || !('attempts' in recovery))
    throw new Error('expected a normal recovery');
  return recovery;
}

function ownerExpectedFromHead(head: NonNullable<ReturnType<typeof readWorkflowStateHead>>) {
  const recovery = head.state.briefRecovery;
  if (recovery === null || recovery === undefined)
    throw new Error('expected a recovery in the persisted head');
  return {
    epochId: recovery.epochId,
    stateRevision: head.revision,
    authorityRevision: head.state.authorityRevision ?? 0,
    fence: String(head.state.stateFence?.token ?? 0),
    evidenceHead: recovery.evidenceHead,
  };
}

function ownerConflictResult(): BriefOwnerCommitResult {
  return {
    kind: 'conflict',
    stateRevision: null,
    authorityRevision: null,
    recovery: null,
    generation: null,
    permit: null,
  };
}

function lockstepOwnerCommit(ref: SessionRef): BriefOwnerCommitPort {
  return (input) => {
    const head = readWorkflowStateHead(ref);
    if (head === null) return ownerConflictResult();
    const recovery = head.state.briefRecovery;
    if (recovery === null || recovery === undefined) return ownerConflictResult();
    if (
      input.expected.epochId !== recovery.epochId ||
      !revisionsMatch(input.expected.stateRevision, head.revision) ||
      (head.state.authorityRevision ?? 0) !== input.expected.authorityRevision ||
      String(head.state.stateFence?.token ?? 0) !== input.expected.fence ||
      input.expected.evidenceHead !== recovery.evidenceHead
    ) {
      return ownerConflictResult();
    }
    return persistBriefOwnerTransition({ ref, ...input });
  };
}

function lockstepOwnerCommitWithFault(
  ref: SessionRef,
  faultPoint: RecoveryFaultPoint,
): BriefOwnerCommitPort {
  return (input) => {
    const head = readWorkflowStateHead(ref);
    if (head === null) return ownerConflictResult();
    const recovery = head.state.briefRecovery;
    if (recovery === null || recovery === undefined) return ownerConflictResult();
    if (
      input.expected.epochId !== recovery.epochId ||
      !revisionsMatch(input.expected.stateRevision, head.revision) ||
      (head.state.authorityRevision ?? 0) !== input.expected.authorityRevision ||
      String(head.state.stateFence?.token ?? 0) !== input.expected.fence ||
      input.expected.evidenceHead !== recovery.evidenceHead
    ) {
      return ownerConflictResult();
    }
    return persistBriefOwnerTransition({
      ref,
      ...input,
      onFault: (point) => {
        if (point === faultPoint) throw new Error(`fault ${faultPoint}`);
      },
    });
  };
}

function passingCandidate(overrides?: Partial<BriefGenerationCandidate>): BriefGenerationCandidate {
  return {
    programId: null,
    parentGenerationId: null,
    batchReceiptDigests: [],
    tasksText: REAL_TASKS_MD,
    qualityReport: evaluateBriefQuality(parseTasksStrict(REAL_TASKS_MD)),
    support: [
      { name: 'research.md', text: '# Research\n' },
      { name: 'plan.md', text: '# Plan\n' },
    ],
    ...overrides,
  };
}

function unparseableCandidate(): BriefGenerationCandidate {
  return passingCandidate({ tasksText: 'no Task Brief blocks in this candidate' });
}

function qualityFailureCandidate(): BriefGenerationCandidate {
  return passingCandidate({
    programId: 'prog-1',
    qualityReport: evaluateBriefQuality([makeBriefQualityFailureTask()]),
    support: [
      { name: 'research.md', text: '# Research\n' },
      { name: 'spec.md', text: '# Spec\n' },
      { name: 'plan.md', text: '# Plan\n' },
    ],
  });
}

function oversizedCandidate(): BriefGenerationCandidate {
  return passingCandidate({
    support: [
      { name: 'research.md', text: '# Research\n' },
      { name: 'plan.md', text: 'x'.repeat(8 * 1024 * 1024 + 1) },
    ],
  });
}

function publishOptions(
  f: BindingFixture,
  candidate: BriefGenerationCandidate,
  eventId: string,
  commit: BriefOwnerCommitPort,
  bus?: EventBus,
  expected?: ReturnType<typeof ownerExpectedFromHead>,
): BriefPublicationOptions {
  const head = readWorkflowStateHead(f.ref);
  if (head === null) throw new Error('expected a committed head');
  return {
    ref: f.ref,
    candidate,
    expected: expected ?? ownerExpectedFromHead(head),
    operationId: eventId,
    eventId,
    recoveryRevision: normalRecovery(head.state).recoveryRevision,
    phase: head.state.phase,
    ts: TS,
    commit,
    bus: bus ?? createEventBus(),
    metadata: TEST_METADATA,
  };
}

async function admitPassingBrief(f: BindingFixture): Promise<void> {
  const admission = f.binding.createAdmissionInput({
    state: f.trackedState(),
    tasks: [makePassingTask()],
    projectDir: f.ref.projectDir,
    sessionId: f.ref.sessionId,
  });
  const admitted = await f.binding.controller.enterBriefAdmission(admission, f.authority());
  expect(admitted).toMatchObject({ kind: 'ready' });
}

function permitFor(
  expected: ReturnType<typeof ownerExpectedFromHead>,
  generation: BriefGenerationRef,
): TaskExecutionPermit {
  return {
    version: 1,
    epochId: expected.epochId,
    authorityRevision: expected.authorityRevision + 1,
    generationId: generation.generationId,
    manifestDigest: generation.manifestDigest,
    tasksDigest: generation.tasksDigest,
    qualityDigest: generation.qualityDigest,
    approvalEvidence: {
      revision: 1,
      hash: generation.qualityDigest,
      path: 'brief-recovery/approval.json',
    },
    issuedAt: NOW,
  };
}

function permitCommitInput(
  ref: SessionRef,
  head: NonNullable<ReturnType<typeof readWorkflowStateHead>>,
  recovery: NormalBriefRecoveryV1,
  generation: BriefGenerationRef,
  permit: TaskExecutionPermit,
): BriefOwnerCommitInput {
  const expected = ownerExpectedFromHead(head);
  const event: BriefOwnerEvent = {
    type: 'brief_execution_permit_issued',
    ts: TS,
    phase: head.state.phase,
    version: 1,
    eventId: `publication-permit-${generation.generationId}`,
    sessionId: ref.sessionId,
    epochId: expected.epochId,
    recoveryRevision: recovery.recoveryRevision,
    operationId: `publication-permit-${generation.generationId}`,
    generation,
    permit,
  };
  return {
    expected,
    operationId: event.operationId,
    evidence: { epochId: expected.epochId, kind: 'outcome', payload: event },
    event,
    projectNext: ({ current }) => {
      const currentRecovery = current.briefRecovery;
      if (
        currentRecovery === null ||
        currentRecovery === undefined ||
        currentRecovery.status !== 'ready'
      ) {
        throw new Error('expected a ready recovery for the permit');
      }
      return {
        disposition: 'ready-for-tasks',
        authorityRevision: expected.authorityRevision + 1,
        generation,
        permit,
        recovery: {
          ...current,
          briefRecovery: currentRecovery as NormalBriefRecoveryV1 & { status: 'ready' },
        },
      };
    },
  };
}

function provenanceDigestOf(candidate: BriefGenerationCandidate): string {
  return sha256Hex(
    canonicalJSON({
      programId: candidate.programId,
      parentGenerationId: candidate.parentGenerationId,
      batchReceiptDigests: [...candidate.batchReceiptDigests],
    }),
  );
}

describe('publication pre-commit fault matrix', () => {
  it.each([
    ['parse', unparseableCandidate, 'publication-fault-parse'],
    ['quality', qualityFailureCandidate, 'publication-fault-quality'],
    ['storage', oversizedCandidate, 'publication-fault-storage'],
    ['event', passingCandidate, 'publication fault event'],
  ] as const)(
    '%s fault leaves the prior authority, projections, and events unchanged',
    async (name, buildCandidate, eventId) => {
      const f = fixture({ modelCache: PRICED_MODEL_CACHE, mode: 'quick' });
      await admitPassingBrief(f);
      const recorder = makeBusRecorder();
      const before = stateBytes(f.ref);
      const tasksBefore = readSpecFile(f.ref, TASKS_FILE);
      const qualityBefore = readSpecFile(f.ref, BRIEF_QUALITY_FILE);

      const result = publishBriefGeneration(
        publishOptions(f, buildCandidate(), eventId, lockstepOwnerCommit(f.ref), recorder.bus),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.fault).toBe(name);
      expect(stateBytes(f.ref)).toBe(before);
      const head = readWorkflowStateHead(f.ref);
      if (head === null) throw new Error('expected the unchanged head');
      expect(head.state.generation ?? null).toBeNull();
      expect(head.state.permit ?? null).toBeNull();
      expect(readSpecFile(f.ref, TASKS_FILE)).toBe(tasksBefore);
      expect(readSpecFile(f.ref, BRIEF_QUALITY_FILE)).toBe(qualityBefore);
      expect(recorder.events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
      expect(
        recorder.events.filter((event) => event.type === 'brief_generation_published'),
      ).toHaveLength(0);
      expect(resolveOwnerReadiness(f.ref)).toEqual({ ok: false, reason: 'no-generation' });

      const observed = observeGenerationStorage(f.ref);
      if (name === 'quality') {
        expect(observed.support).toHaveLength(1);
        expect(observed.generations).toHaveLength(0);
      } else if (name === 'event') {
        expect(observed.generations).toHaveLength(1);
        expect(observed.candidateDirs).toHaveLength(0);
      } else {
        expect(observed.generations).toHaveLength(0);
        expect(observed.support).toHaveLength(0);
        expect(observed.candidateDirs).toHaveLength(0);
      }
      expect(WorkflowStateSchema.safeParse(head.state).success).toBe(true);
    },
  );

  it('a stale CAS loser leaves the committed head byte-identical and adds no evidence', async () => {
    const f = fixture({ modelCache: PRICED_MODEL_CACHE, mode: 'quick' });
    await admitPassingBrief(f);
    const candidate = passingCandidate();
    const recorder = makeBusRecorder();
    const headBefore = readWorkflowStateHead(f.ref);
    if (headBefore === null) throw new Error('expected the pre-publish head');
    const expected = ownerExpectedFromHead(headBefore);
    const first = publishBriefGeneration(
      publishOptions(f, candidate, 'publication-first', lockstepOwnerCommit(f.ref), recorder.bus),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const committedBytes = stateBytes(f.ref);
    const tasksProjected = readSpecFile(f.ref, TASKS_FILE);

    const stale = publishBriefGeneration(
      publishOptions(
        f,
        candidate,
        'publication-stale',
        lockstepOwnerCommit(f.ref),
        recorder.bus,
        expected,
      ),
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.fault).toBe('cas');
    expect(stateBytes(f.ref)).toBe(committedBytes);
    expect(readSpecFile(f.ref, TASKS_FILE)).toBe(tasksProjected);
    expect(
      readRecoveryJournal(f.ref).records.filter((record) => record.eventId === 'publication-stale'),
    ).toHaveLength(0);
    expect(resolveOwnerReadiness(f.ref)).toEqual({ ok: false, reason: 'no-permit' });
  });

  it('evidence faults through the owner seam keep the head byte-identical and still converge', async () => {
    const f = fixture({ modelCache: PRICED_MODEL_CACHE, mode: 'quick' });
    await admitPassingBrief(f);
    const recorder = makeBusRecorder();
    const before = stateBytes(f.ref);
    const tasksBefore = readSpecFile(f.ref, TASKS_FILE);
    const qualityBefore = readSpecFile(f.ref, BRIEF_QUALITY_FILE);
    const rows = [
      ['before-evidence', 'publication-fault-before-evidence', 0],
      ['after-evidence', 'publication-fault-after-evidence', 1],
      ['before-state-cas', 'publication-fault-before-state-cas', 1],
    ] as const;
    for (const [point, eventId, records] of rows) {
      const stateBefore = stateBytes(f.ref);
      const result = publishBriefGeneration(
        publishOptions(
          f,
          passingCandidate(),
          eventId,
          lockstepOwnerCommitWithFault(f.ref, point),
          recorder.bus,
        ),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.fault).toBe('event');
      expect(stateBytes(f.ref)).toBe(stateBefore);
      expect(
        readRecoveryJournal(f.ref).records.filter((record) => record.eventId === eventId),
      ).toHaveLength(records);
      expect(resolveOwnerReadiness(f.ref)).toEqual({ ok: false, reason: 'no-generation' });
    }
    expect(stateBytes(f.ref)).toBe(before);
    expect(readSpecFile(f.ref, TASKS_FILE)).toBe(tasksBefore);
    expect(readSpecFile(f.ref, BRIEF_QUALITY_FILE)).toBe(qualityBefore);

    const converged = publishBriefGeneration(
      publishOptions(
        f,
        passingCandidate(),
        'publication-fault-converged',
        lockstepOwnerCommit(f.ref),
        recorder.bus,
      ),
    );
    expect(converged.ok).toBe(true);
    if (!converged.ok) return;
    expect(stateBytes(f.ref)).not.toBe(before);
    expect(
      readRecoveryJournal(f.ref).records.filter(
        (record) => record.eventId === 'publication-fault-converged',
      ),
    ).toHaveLength(1);
  });

  it('a crash after the state CAS leaves a pending outbox that drains once and stays non-executable', async () => {
    const f = fixture({ modelCache: PRICED_MODEL_CACHE, mode: 'quick' });
    await admitPassingBrief(f);
    const candidate = passingCandidate();
    const identity = buildBriefGenerationIdentity(candidate);
    const recorder = makeBusRecorder();
    const eventId = 'publication-crash-after-cas';
    const before = stateBytes(f.ref);
    const tasksBefore = readSpecFile(f.ref, TASKS_FILE);
    const qualityBefore = readSpecFile(f.ref, BRIEF_QUALITY_FILE);
    const crashHead = readWorkflowStateHead(f.ref);
    if (crashHead === null) throw new Error('expected the pre-crash head');
    const crashExpected = ownerExpectedFromHead(crashHead);

    const crashed = publishBriefGeneration(
      publishOptions(
        f,
        candidate,
        eventId,
        lockstepOwnerCommitWithFault(f.ref, 'after-state-commit'),
        recorder.bus,
      ),
    );
    expect(crashed.ok).toBe(false);
    if (crashed.ok) return;
    expect(crashed.fault).toBe('event');
    expect(stateBytes(f.ref)).not.toBe(before);
    const head = readWorkflowStateHead(f.ref);
    if (head === null) throw new Error('expected the committed head');
    expect(head.state.generation).toEqual(identity.ref);
    expect(head.state.permit).toBeNull();
    expect(readSpecFile(f.ref, TASKS_FILE)).toBe(tasksBefore);
    expect(readSpecFile(f.ref, BRIEF_QUALITY_FILE)).toBe(qualityBefore);
    expect(recorder.events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
    expect(
      recorder.events.filter((event) => event.type === 'brief_generation_published'),
    ).toHaveLength(0);
    expect(
      readRecoveryJournal(f.ref).records.filter((record) => record.eventId === eventId),
    ).toHaveLength(1);
    expect(resolveOwnerReadiness(f.ref)).toEqual({ ok: false, reason: 'no-permit' });
    expect(
      planningResultForState({ sessionId: f.ref.sessionId, state: head.state }).disposition,
    ).toBe('parked');

    let delivered = 0;
    let deliveredPayload: unknown = null;
    const drained = drainRecoveryOutbox({
      ref: f.ref,
      deliver: (input) => {
        delivered += 1;
        deliveredPayload = input.payload;
      },
    });
    expect(delivered).toBe(1);
    expect(drained.deliveredEventIds).toEqual([eventId]);
    expect(drained.remainingEventIds).toHaveLength(0);
    expect(deliveredPayload).toMatchObject({
      type: 'brief_generation_published',
      eventId,
      generation: identity.ref,
      provenanceDigest: provenanceDigestOf(candidate),
    });
    const again = drainRecoveryOutbox({ ref: f.ref, deliver: () => (delivered += 1) });
    expect(delivered).toBe(1);
    expect(again.remainingEventIds).toHaveLength(0);

    const afterDrain = stateBytes(f.ref);
    const replay = publishBriefGeneration(
      publishOptions(
        f,
        candidate,
        eventId,
        lockstepOwnerCommit(f.ref),
        recorder.bus,
        crashExpected,
      ),
    );
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.fault).toBe('cas');
    expect(stateBytes(f.ref)).toBe(afterDrain);
    expect(
      readRecoveryJournal(f.ref).records.filter((record) => record.eventId === eventId),
    ).toHaveLength(1);

    const converged = publishBriefGeneration(
      publishOptions(
        f,
        candidate,
        'publication-crash-converged',
        lockstepOwnerCommit(f.ref),
        recorder.bus,
      ),
    );
    expect(converged.ok).toBe(true);
    if (!converged.ok) return;
    expect(converged.committed.generation).toEqual(identity.ref);
    expect(observeGenerationStorage(f.ref).generations).toHaveLength(1);
    expect(resolveOwnerReadiness(f.ref)).toEqual({ ok: false, reason: 'no-permit' });
  });
});

describe('publication concurrency matrix', () => {
  it('two owners publishing the same candidate commit exactly one generation', async () => {
    const f = fixture({ modelCache: PRICED_MODEL_CACHE, mode: 'quick' });
    await admitPassingBrief(f);
    const a = makeBinding(f.ref, { modelCache: PRICED_MODEL_CACHE });
    const b = makeBinding(f.ref, { modelCache: PRICED_MODEL_CACHE });
    const candidate = passingCandidate();
    const raceHead = readWorkflowStateHead(f.ref);
    if (raceHead === null) throw new Error('expected the race head');
    const expected = ownerExpectedFromHead(raceHead);

    const first = publishBriefGeneration(
      publishOptions(
        a,
        candidate,
        'publication-race-a',
        lockstepOwnerCommit(f.ref),
        undefined,
        expected,
      ),
    );
    const second = publishBriefGeneration(
      publishOptions(
        b,
        candidate,
        'publication-race-b',
        lockstepOwnerCommit(f.ref),
        undefined,
        expected,
      ),
    );
    const winners = [first, second].filter((result) => result.ok);
    const losers = [first, second].filter((result) => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const winner = winners[0];
    const loser = losers[0];
    if (winner === undefined || loser === undefined) return;
    expect(winner.ok).toBe(true);
    expect(loser.ok).toBe(false);
    if (!winner.ok || loser.ok) return;
    expect(loser.fault).toBe('cas');
    const head = readWorkflowStateHead(f.ref);
    if (head === null) throw new Error('expected a committed head');
    expect(
      readRecoveryJournal(f.ref).records.filter(
        (record) =>
          record.eventId === 'publication-race-a' || record.eventId === 'publication-race-b',
      ),
    ).toHaveLength(1);
    expect(observeGenerationStorage(f.ref).generations).toHaveLength(1);
    expect(observeGenerationStorage(f.ref).candidateDirs).toHaveLength(0);
    expect(resolveOwnerReadiness(f.ref)).toEqual({ ok: false, reason: 'no-permit' });
    expect(WorkflowStateSchema.safeParse(head.state).success).toBe(true);
  });

  it('a CAS loser leaves only a bounded unreferenced candidate', async () => {
    const f = fixture({ modelCache: PRICED_MODEL_CACHE, mode: 'quick' });
    await admitPassingBrief(f);
    const a = makeBinding(f.ref, { modelCache: PRICED_MODEL_CACHE });
    const b = makeBinding(f.ref, { modelCache: PRICED_MODEL_CACHE });
    const candidateB = passingCandidate({
      tasksText: REAL_TASKS_MD.replace(
        'Add JWT-based authentication.',
        'Add JWT-based authentication (second attempt).',
      ),
    });
    const candidateC = passingCandidate({
      tasksText: REAL_TASKS_MD.replace(
        'Add JWT-based authentication.',
        'Add JWT-based authentication (third attempt).',
      ),
    });
    const raceHead = readWorkflowStateHead(f.ref);
    if (raceHead === null) throw new Error('expected the race head');
    const expected = ownerExpectedFromHead(raceHead);

    const first = publishBriefGeneration(
      publishOptions(
        a,
        candidateB,
        'publication-race-b',
        lockstepOwnerCommit(f.ref),
        undefined,
        expected,
      ),
    );
    const second = publishBriefGeneration(
      publishOptions(
        b,
        candidateC,
        'publication-race-c',
        lockstepOwnerCommit(f.ref),
        undefined,
        expected,
      ),
    );
    const winner = [first, second].find((result) => result.ok);
    const loser = [first, second].find((result) => !result.ok);
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    if (winner === undefined || loser === undefined || !winner.ok || loser.ok) return;
    expect(loser.fault).toBe('cas');
    if (winner.committed.generation === null) throw new Error('expected the committed generation');
    const head = readWorkflowStateHead(f.ref);
    if (head === null) throw new Error('expected a committed head');
    expect(head.state.generation).toEqual(winner.committed.generation);
    const observed = observeGenerationStorage(f.ref);
    expect(observed.generations).toHaveLength(2);
    expect(
      observed.generations.filter(
        (stored) => stored.generationId === winner.committed.generation?.generationId,
      ),
    ).toHaveLength(1);
    expect(
      readRecoveryJournal(f.ref).records.filter(
        (record) =>
          record.eventId === 'publication-race-b' || record.eventId === 'publication-race-c',
      ),
    ).toHaveLength(1);
    expect(resolveOwnerReadiness(f.ref)).toEqual({ ok: false, reason: 'no-permit' });
  });

  it('a replacement publication atomically clears the current permit', async () => {
    const f = fixture({ modelCache: PRICED_MODEL_CACHE, mode: 'quick' });
    await admitPassingBrief(f);
    const candidateA = passingCandidate();
    const publishedA = publishBriefGeneration(
      publishOptions(f, candidateA, 'publication-first', lockstepOwnerCommit(f.ref)),
    );
    expect(publishedA.ok).toBe(true);
    if (!publishedA.ok) return;
    if (publishedA.committed.generation === null) throw new Error('expected generation A');
    const generationA = publishedA.committed.generation;
    const headA = readWorkflowStateHead(f.ref);
    if (headA === null) throw new Error('expected the generation head');
    const permit = permitFor(ownerExpectedFromHead(headA), generationA);
    const permitCommit = lockstepOwnerCommit(f.ref)(
      permitCommitInput(f.ref, headA, normalRecovery(headA.state), generationA, permit),
    );
    expect(permitCommit.kind).toBe('committed');
    if (permitCommit.kind !== 'committed') return;
    expect(resolveOwnerReadiness(f.ref)).toEqual({
      ok: true,
      authorityRevision: permitCommit.authorityRevision,
      generation: generationA,
      permit,
    });

    const candidateB = passingCandidate({
      tasksText: REAL_TASKS_MD.replace(
        'Add JWT-based authentication.',
        'Add JWT-based authentication (replacement).',
      ),
    });
    const publishedB = publishBriefGeneration(
      publishOptions(f, candidateB, 'publication-replacement', lockstepOwnerCommit(f.ref)),
    );
    expect(publishedB.ok).toBe(true);
    if (!publishedB.ok) return;
    if (publishedB.committed.generation === null) throw new Error('expected generation B');
    const generationB = publishedB.committed.generation;
    expect(generationB.generationId).not.toBe(generationA.generationId);
    const headB = readWorkflowStateHead(f.ref);
    if (headB === null) throw new Error('expected the replacement head');
    expect(headB.state.generation).toEqual(generationB);
    expect(headB.state.permit).toBeNull();
    expect(resolveOwnerReadiness(f.ref)).toEqual({ ok: false, reason: 'no-permit' });
    expect(
      planningResultForState({ sessionId: f.ref.sessionId, state: headB.state }).disposition,
    ).toBe('parked');

    const beforeRevive = stateBytes(f.ref);
    const revive = issueApprovedGenerationPermit({
      ref: f.ref,
      epochId: ownerExpectedFromHead(headB).epochId,
      authorityRevision: headB.state.authorityRevision ?? 0,
      generation: generationA,
      qualityDigest: generationA.qualityDigest,
      commit: lockstepOwnerCommit(f.ref),
    });
    expect(revive).toMatchObject({ kind: 'refused', reason: 'generation-mismatch' });
    expect(stateBytes(f.ref)).toBe(beforeRevive);
    expect(resolveOwnerReadiness(f.ref)).toEqual({ ok: false, reason: 'no-permit' });
    expect(observeGenerationStorage(f.ref).generations).toHaveLength(2);
  });
});

describe('approval, permit, and budget failpoints', () => {
  it('approval cannot issue a mismatched permit and the matching permit opens readiness', async () => {
    const f = fixture({ modelCache: PRICED_MODEL_CACHE, mode: 'quick' });
    await admitPassingBrief(f);
    const candidate = passingCandidate();
    const published = publishBriefGeneration(
      publishOptions(f, candidate, 'publication-parked', lockstepOwnerCommit(f.ref)),
    );
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    if (published.committed.generation === null)
      throw new Error('expected the committed generation');
    const generation = published.committed.generation;
    const head = readWorkflowStateHead(f.ref);
    if (head === null) throw new Error('expected the parked head');
    const recovery = normalRecovery(head.state);
    const expected = ownerExpectedFromHead(head);
    expect(resolveOwnerReadiness(f.ref)).toEqual({ ok: false, reason: 'no-permit' });

    const base: ApprovedGenerationPermitOptions = {
      ref: f.ref,
      epochId: expected.epochId,
      authorityRevision: expected.authorityRevision,
      generation,
      qualityDigest: generation.qualityDigest,
      commit: lockstepOwnerCommit(f.ref),
      now: () => NOW,
    };
    const refusalRows = [
      {
        reason: 'epoch-mismatch',
        make: (input: ApprovedGenerationPermitOptions) => ({ ...input, epochId: 'wrong-epoch' }),
      },
      {
        reason: 'revision-mismatch',
        make: (input: ApprovedGenerationPermitOptions) => ({
          ...input,
          authorityRevision: input.authorityRevision + 1,
        }),
      },
      {
        reason: 'generation-mismatch',
        make: (input: ApprovedGenerationPermitOptions) => ({
          ...input,
          generation: { ...input.generation, generationId: 'brief-wrong-generation' },
        }),
      },
      {
        reason: 'digest-mismatch',
        make: (input: ApprovedGenerationPermitOptions) => ({
          ...input,
          qualityDigest: sha256Hex('wrong-quality'),
        }),
      },
    ] as const;
    for (const row of refusalRows) {
      const before = stateBytes(f.ref);
      const refused = issueApprovedGenerationPermit(row.make(base));
      expect(refused).toMatchObject({ kind: 'refused', reason: row.reason });
      expect(stateBytes(f.ref)).toBe(before);
      expect(resolveOwnerReadiness(f.ref)).toEqual({ ok: false, reason: 'no-permit' });
    }
    expect(
      readRecoveryJournal(f.ref).records.filter((record) =>
        record.eventId.startsWith('approval-permit-'),
      ),
    ).toHaveLength(0);

    const permit = permitFor(expected, generation);
    const committed = lockstepOwnerCommit(f.ref)(
      permitCommitInput(f.ref, head, recovery, generation, permit),
    );
    expect(committed.kind).toBe('committed');
    if (committed.kind !== 'committed') return;
    expect(committed.permit).toEqual(permit);
    expect(resolveOwnerReadiness(f.ref)).toEqual({
      ok: true,
      authorityRevision: committed.authorityRevision,
      generation,
      permit,
    });
    const projectedTasks = readSpecFile(f.ref, TASKS_FILE);
    expect(projectedTasks).not.toBeNull();
    if (projectedTasks === null) return;
    expect(parseTasksStrict(projectedTasks)).toEqual(parseTasksStrict(candidate.tasksText));
    const projectedQuality = readSpecFile(f.ref, BRIEF_QUALITY_FILE);
    expect(projectedQuality).not.toBeNull();
    if (projectedQuality === null) return;
    expect(sha256Hex(projectedQuality)).toBe(generation.qualityDigest);
  });

  it('a budget refusal settles nothing and leaves no generation, permit, or candidate', async () => {
    const review = vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null });
    const f = fixture({
      planner: makePassingPlanner({ review }),
      modelCache: PRICED_MODEL_CACHE,
      maxBudget: 1,
      mode: 'standard',
      model: 'not-in-catalog-model',
    });
    const admission = f.binding.createAdmissionInput({
      state: f.trackedState(),
      tasks: [makeBriefQualityFailureTask()],
      projectDir: f.ref.projectDir,
      sessionId: f.ref.sessionId,
    });
    const refused = await f.binding.controller.enterBriefAdmission(admission, f.authority());
    expect(refused).toMatchObject({
      kind: 'blocked',
      code: 'brief_budget_unknown',
      projection: { budget: { state: 'refused', refusalCode: 'brief_budget_unknown' } },
    });
    expect(review).not.toHaveBeenCalled();
    const head = readWorkflowStateHead(f.ref);
    if (head === null) throw new Error('expected a committed head');
    expect(head.state.generation ?? null).toBeNull();
    expect(head.state.permit ?? null).toBeNull();
    expect(observeGenerationStorage(f.ref).generations).toHaveLength(0);
    expect(observeGenerationStorage(f.ref).support).toHaveLength(0);
    expect(resolveOwnerReadiness(f.ref).ok).toBe(false);
    expect(WorkflowStateSchema.safeParse(head.state).success).toBe(true);
  });
});
