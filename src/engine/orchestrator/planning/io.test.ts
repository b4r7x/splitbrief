import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, linkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
} from '#testing/helpers/orchestrator-task-context.js';
import { readSpecFile, writeSpecFile, type SpecMetadata } from '../../../core/paths-io.js';
import {
  PLAN_FILE,
  RESEARCH_FILE,
  SPEC_FILE,
  TASKS_FILE,
  sessionDir,
} from '../../../core/paths.js';
import { formatTasks } from '../../spec/formatter.js';
import { persistPhases, readPersistedTasks, resolveOwnerReadiness } from './io.js';
import type { PhaseResult, PlannerArtifactLogicalName } from '../../planners/types.js';
import {
  createTaskCompilationAttemptId,
  OwnedPlannerArtifactSchema,
} from '../../../core/schemas/task-compilation.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { createBriefRecoveryState } from './brief-recovery.js';
import { createInitialState } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { BriefGenerationRef, TaskExecutionPermit } from '../../../core/schemas/brief-owner.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const tmpDirs: string[] = [];
const TEST_METADATA: SpecMetadata = {
  plannerTool: 'claude-code',
  plannerModel: 'opus',
  implementerTool: 'codex',
  implementerModel: 'gpt-5',
  mode: 'standard',
};

const GENERATION: BriefGenerationRef = {
  generationId: 'generation-owner-a1b2c3d4e5f60718',
  manifestDigest: sha256Hex('manifest'),
  tasksDigest: sha256Hex('tasks'),
  qualityDigest: sha256Hex('quality'),
  programId: null,
};

function permitFor(generation: BriefGenerationRef): TaskExecutionPermit {
  return {
    version: 1,
    epochId: 'epoch-1',
    authorityRevision: 1,
    generationId: generation.generationId,
    manifestDigest: generation.manifestDigest,
    tasksDigest: generation.tasksDigest,
    qualityDigest: generation.qualityDigest,
    approvalEvidence: {
      revision: 1,
      hash: sha256Hex('approval'),
      path: 'brief-recovery/epochs/epoch-1/payload/approval.json',
    },
    issuedAt: '2026-08-15T00:00:00.000Z',
  };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
  cleanupTaskProjects();
});

function makeTasksMarkdown(): string {
  return formatTasks([
    makeTask({
      implementationSteps: ['Update the target module'],
      tests: ['focused tests pass'],
      evidence: ['test output captured'],
      scope: { inBounds: ['src/hello.ts'] },
    }),
  ]);
}

function phaseResult(logicalName: PlannerArtifactLogicalName, text: string): PhaseResult {
  const digest = sha256Hex(text);
  return {
    artifact: OwnedPlannerArtifactSchema.parse({
      semanticId: `test-${logicalName}`,
      programId: null,
      batchId: null,
      attemptId: createTaskCompilationAttemptId(),
      logicalName,
      transport: 'stdout-final',
      text,
      byteLength: Buffer.byteLength(text, 'utf8'),
      sha256: digest,
      runtimeReceipt: digest,
      terminal: { status: 'completed', recordId: `test-${logicalName}`, protocolDigest: digest },
      sourceReceipt: { kind: 'stdout-final', resultDigest: digest },
    }),
  };
}

describe('readPersistedTasks', () => {
  itUnix('rejects symlinked tasks.md before parsing', async () => {
    const sessionDir = createTempDir('planning-io-symlink-session');
    const outsideDir = createTempDir('planning-io-symlink-outside');
    tmpDirs.push(sessionDir, outsideDir);
    writeFileSync(join(outsideDir, 'tasks.md'), makeTasksMarkdown());
    symlinkSync(join(outsideDir, 'tasks.md'), join(sessionDir, 'tasks.md'));

    const result = await readPersistedTasks(join(sessionDir, 'tasks.md'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected symlinked tasks.md to be rejected');
    expect(result.reason).toBe('unreadable');
    expect(result.message).toMatch(/symlink/i);
  });

  itUnix('rejects hardlinked tasks.md before parsing', async () => {
    const sessionDir = createTempDir('planning-io-hardlink-session');
    const outsideDir = createTempDir('planning-io-hardlink-outside');
    tmpDirs.push(sessionDir, outsideDir);
    writeFileSync(join(outsideDir, 'tasks.md'), makeTasksMarkdown());
    linkSync(join(outsideDir, 'tasks.md'), join(sessionDir, 'tasks.md'));

    const result = await readPersistedTasks(join(sessionDir, 'tasks.md'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected hardlinked tasks.md to be rejected');
    expect(result.reason).toBe('unreadable');
    expect(result.message).toMatch(/hardlink/i);
  });
});

describe('persistPhases', () => {
  it('writes and publishes each already-admitted phase artifact once', () => {
    const projectDir = createTempDir('planning-io-phases');
    tmpDirs.push(projectDir);
    const sessionId = 'persist-phases';
    const { bus, events } = makeBusRecorder();
    const researchPhase = phaseResult(RESEARCH_FILE, '# Research\n\nFindings.');
    const specPhase = phaseResult(SPEC_FILE, '# Spec\n\nRequirements.');
    const planPhase = phaseResult(PLAN_FILE, '# Plan\n\nSteps.');
    const tasksPhase = phaseResult(TASKS_FILE, makeTasksMarkdown());
    const phases = [researchPhase, specPhase, planPhase, tasksPhase];

    persistPhases({
      projectDir,
      sessionId,
      phases,
      metadata: TEST_METADATA,
      bus,
      phase: 'planning',
      generation: GENERATION,
    });

    expect(readSpecFile({ projectDir, sessionId }, RESEARCH_FILE)).toBe(
      researchPhase.artifact.text,
    );
    expect(readSpecFile({ projectDir, sessionId }, SPEC_FILE)).toContain(specPhase.artifact.text);
    expect(readSpecFile({ projectDir, sessionId }, PLAN_FILE)).toContain(planPhase.artifact.text);
    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toContain(tasksPhase.artifact.text);
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(phases.length);
    expect(
      events.filter((event) => event.type === 'artifact_written').map((event) => event.filename),
    ).toEqual(phases.map((phase) => phase.artifact.logicalName));
  });

  it('does not re-admit a spec phase that was validated by the planner', () => {
    const projectDir = createTempDir('planning-io-admitted');
    tmpDirs.push(projectDir);
    const { bus, events } = makeBusRecorder();

    persistPhases({
      projectDir,
      sessionId: 'persist-admitted',
      phases: [phaseResult(SPEC_FILE, 'Planner-admitted prose without a heading.')],
      metadata: TEST_METADATA,
      bus,
      phase: 'planning',
    });

    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(1);
    expect(readSpecFile({ projectDir, sessionId: 'persist-admitted' }, SPEC_FILE)).toContain(
      'Planner-admitted prose without a heading.',
    );
  });

  it('accepts a canonical phase artifact with its logical name', () => {
    const projectDir = createTempDir('planning-io-unknown-artifact');
    tmpDirs.push(projectDir);
    const { bus, events } = makeBusRecorder();

    persistPhases({
      projectDir,
      sessionId: 'persist-known-artifact',
      phases: [phaseResult(SPEC_FILE, '# Known')],
      metadata: TEST_METADATA,
      bus,
      phase: 'planning',
    });
    expect(
      events.filter((event) => event.type === 'artifact_written').map((event) => event.filename),
    ).toEqual([SPEC_FILE]);
  });
});

describe('persistPhases — committed-generation projections', () => {
  it('rejects a Task Briefs phase without a committed generation receipt before any write', () => {
    const projectDir = createTempDir('planning-io-no-receipt');
    tmpDirs.push(projectDir);
    const { bus, events } = makeBusRecorder();

    expect(() =>
      persistPhases({
        projectDir,
        sessionId: 'persist-no-receipt',
        phases: [phaseResult(TASKS_FILE, makeTasksMarkdown())],
        metadata: TEST_METADATA,
        bus,
        phase: 'planning',
      }),
    ).toThrowError(expect.objectContaining({ kind: 'artifact-projection-requires-generation' }));
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
    expect(existsSync(join(sessionDir(projectDir, 'persist-no-receipt'), TASKS_FILE))).toBe(false);
  });

  it('prevalidates the whole phase array before writing any artifact', () => {
    const projectDir = createTempDir('planning-io-batch-prevalidate');
    tmpDirs.push(projectDir);
    const { bus, events } = makeBusRecorder();

    expect(() =>
      persistPhases({
        projectDir,
        sessionId: 'persist-batch-invalid',
        phases: [
          phaseResult(RESEARCH_FILE, '# Research\n\nFindings.'),
          phaseResult(TASKS_FILE, makeTasksMarkdown()),
        ],
        metadata: TEST_METADATA,
        bus,
        phase: 'planning',
      }),
    ).toThrowError(expect.objectContaining({ kind: 'artifact-projection-requires-generation' }));
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
    expect(existsSync(join(sessionDir(projectDir, 'persist-batch-invalid'), RESEARCH_FILE))).toBe(
      false,
    );
  });
});

describe('resolveOwnerReadiness — owner state is the only authority', () => {
  function ownerState(
    generation: BriefGenerationRef | null,
    permit: TaskExecutionPermit | null,
  ): WorkflowState {
    const activeBrief = { revision: 1, hash: sha256Hex('brief'), path: 'brief.json' };
    const recovery = createBriefRecoveryState(
      {
        sessionId: 'sess-owner-io',
        origin: { mode: 'standard', entry: 'initial' },
        continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
        activeBrief,
        report: {
          briefHash: activeBrief.hash,
          report: { revision: 1, hash: sha256Hex('report'), path: 'brief-quality.json' },
          ruleVersion: 'quality-v1',
          issues: [],
          errorCount: 0,
        },
        qualityPolicyVersion: 'quality-v1',
      },
      { epochId: 'epoch-1' },
    );
    return {
      ...createInitialState('feat'),
      phase: 'reviewing-briefs',
      briefRecovery: recovery,
      authorityRevision: 1,
      generation,
      permit,
    };
  }

  it('resolves readiness from the owner state when the fixed tasks.md contradicts it', async () => {
    const wctx = makeTaskWorkflowContext();
    const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
    saveState(wctx, ownerState(GENERATION, permitFor(GENERATION)));
    writeSpecFile(ref, TASKS_FILE, 'not task briefs at all', null);

    const readiness = resolveOwnerReadiness(ref);
    expect(readiness).toMatchObject({
      ok: true,
      generation: GENERATION,
      permit: permitFor(GENERATION),
    });
    const persisted = await readPersistedTasks(
      join(sessionDir(ref.projectDir, ref.sessionId), TASKS_FILE),
    );
    expect(persisted.ok).toBe(false);
  });

  it('stays blocked when the owner state has no current permit even if tasks.md exists', () => {
    const wctx = makeTaskWorkflowContext();
    const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
    saveState(wctx, ownerState(GENERATION, null));
    writeSpecFile(ref, TASKS_FILE, makeTasksMarkdown(), null);

    expect(resolveOwnerReadiness(ref)).toEqual({ ok: false, reason: 'no-permit' });
  });

  it('returns blocked reasons for a missing state and a missing generation', () => {
    const wctx = makeTaskWorkflowContext();
    const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
    expect(resolveOwnerReadiness(ref)).toEqual({ ok: false, reason: 'no-state' });
    saveState(wctx, ownerState(null, null));
    expect(resolveOwnerReadiness(ref)).toEqual({ ok: false, reason: 'no-generation' });
  });

  it('returns no-recovery when the state has no Brief recovery authority', () => {
    const wctx = makeTaskWorkflowContext();
    const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
    saveState(wctx, { ...createInitialState('feat'), phase: 'reviewing-briefs' });
    expect(resolveOwnerReadiness(ref)).toEqual({ ok: false, reason: 'no-recovery' });
  });

  it('returns not-ready while the recovery authority is not ready', () => {
    const wctx = makeTaskWorkflowContext();
    const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
    const state = ownerState(GENERATION, null);
    const recovery = state.briefRecovery;
    if (recovery === null || recovery === undefined) {
      throw new Error('expected a Brief recovery state');
    }
    if (recovery.status === 'rejected' || recovery.status === 'storage-blocked') {
      throw new Error('expected a normal Brief recovery state');
    }
    saveState(wctx, { ...state, briefRecovery: { ...recovery, status: 'blocked' as const } });
    expect(resolveOwnerReadiness(ref)).toEqual({ ok: false, reason: 'not-ready' });
  });

  it('projects a provider candidate without changing the owner authority', () => {
    const wctx = makeTaskWorkflowContext();
    const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
    saveState(wctx, ownerState(GENERATION, permitFor(GENERATION)));
    const providerText = makeTasksMarkdown();
    const otherGeneration: BriefGenerationRef = {
      ...GENERATION,
      generationId: 'generation-provider-0123456789abcdef',
      tasksDigest: sha256Hex('other-tasks'),
    };
    const { bus, events } = makeBusRecorder();

    persistPhases({
      ...ref,
      phases: [phaseResult(TASKS_FILE, providerText)],
      metadata: TEST_METADATA,
      bus,
      phase: 'reviewing-briefs',
      generation: otherGeneration,
    });

    expect(readSpecFile(ref, TASKS_FILE)).toContain(providerText);
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(1);
    expect(resolveOwnerReadiness(ref)).toMatchObject({
      ok: true,
      generation: GENERATION,
      permit: permitFor(GENERATION),
    });
  });
});
