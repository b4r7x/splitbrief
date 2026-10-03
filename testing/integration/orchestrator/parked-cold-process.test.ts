import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import { STATE_FILE, sessionDir } from '../../../src/core/paths.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { readSession } from '../../../src/core/sessions/io.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { WORKFLOW_CANCEL_REASON_USER } from '../../../src/engine/events/workflow-cancel.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import { createRunIsolation } from '../../../src/engine/orchestrator/isolation/create.js';
import {
  readWorkspaceRecord,
  retainedStagedDirectory,
  workspaceOwner,
} from '../../../src/engine/orchestrator/isolation/retention.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { typedCallFromTasks } from '#testing/helpers/typed-planner.js';

// Cold-process proof harness. The host runs this file once per matrix cell:
//   F2B_PROOF_DIR=<fixture> F2B_PROOF_ENTRY=<n> F2B_PROOF_ROUTE=<initial|local|hint>
// Each cell is one independent process over the fixture; entries 0..2 keep the
// same retained stage, bytes, attempt, and canonical session log. Retirement is
// common to MAIN and CLONE; the End composition runs only when the host sets
// F2B_PROOF_MAIN_END=1, so CLONE skips exactly that one case.
type ColdRoute = 'initial' | 'local' | 'hint';

type ColdObservation = {
  attempt: number;
  workspace: string;
  previous: string | null;
  fallback: boolean;
  continuation: ImplementerOptions['continuation'];
  stageLeaf: string | null;
  stageUnchanged: boolean | null;
};

const COLD_FEATURE = 'Build partial module';
const COLD_SESSION = 'parked-workflow';

const proofDir = process.env.F2B_PROOF_DIR;
const proofEntry = Number(process.env.F2B_PROOF_ENTRY);
const proofMainEnd = process.env.F2B_PROOF_MAIN_END === '1';
const proofRoute = coldRouteFromEnv();
const matrixActive = proofDir !== undefined && Number.isInteger(proofEntry) && proofEntry >= 0;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function coldRouteFromEnv(): ColdRoute {
  const raw = (process.env.F2B_PROOF_ROUTE ?? process.env.F2B_ROUTE ?? 'initial').toLowerCase();
  return raw === 'local' || raw === 'hint' ? raw : 'initial';
}

function makeColdTask() {
  return makeTask({
    file: 'partial.ts',
    scope: { inBounds: ['partial.ts'], outOfBounds: ['other files'] },
    evidence: ['The module exports complete'],
    typeDefs: 'export const complete: boolean',
  });
}

function makeColdConfig() {
  return makeNoValidationConfig({
    workflow: { approve: 'none', maxRetries: 1 },
    approval: { enabled: false, feedRejectionsToPlanner: false },
  });
}

function assertUnborn(dir: string) {
  expect(existsSync(join(dir, '.git/index'))).toBe(false);
  expect(existsSync(join(dir, '.git/worktrees'))).toBe(false);
  expect(readdirSync(join(dir, '.git/refs/heads'))).toEqual([]);
  expect(readdirSync(join(dir, '.git/objects')).sort()).toEqual(['info', 'pack']);
  expect(readdirSync(join(dir, '.git/objects/pack'))).toEqual([]);
}

async function runColdEntry(input: {
  projectDir: string;
  entryNumber: number;
  route: ColdRoute;
}): Promise<{
  observations: ColdObservation[];
  state: WorkflowState;
  stage: string | null;
  logPath: string;
}> {
  const { projectDir, entryNumber, route } = input;
  const sessionId = COLD_SESSION;
  const ref = { projectDir, sessionId };
  const task = makeColdTask();
  const config = makeColdConfig();
  const saved: WorkflowState | undefined = loadState(ref) ?? undefined;
  const recordBefore = existsSync(sessionDir(projectDir, sessionId))
    ? await readWorkspaceRecord(ref)
    : null;
  const stageBefore =
    recordBefore?.location.kind === 'staged-copy' && recordBefore.retained === true
      ? retainedStagedDirectory(ref, recordBefore)
      : null;
  const observations: ColdObservation[] = [];
  const stop = new AbortController();
  const bus = createEventBus();
  let fallback = false;
  bus.subscribe((event) => {
    if (
      event.type === 'warning' &&
      (event.message.includes('repository has no commits') ||
        event.message.includes('resuming retained staged-copy workspace'))
    )
      fallback = true;
  });
  const planner = makePlanner({
    ...(route === 'hint'
      ? {
          escalateHint: async () => ({
            success: true,
            output: 'Use the existing module.',
            code: null,
            usage: null,
          }),
        }
      : {}),
    typedCall: typedCallFromTasks([task]),
  });
  const writeAndStop = async (opts: ImplementerOptions) => {
    assertUnborn(projectDir);
    expect(fallback).toBe(true);
    expect(existsSync(join(opts.projectDir, '.git'))).toBe(false);
    expect(existsSync(join(opts.projectDir, '.splitbrief', 'sessions', sessionId))).toBe(false);
    const path = join(opts.projectDir, 'partial.ts');
    const previous = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const record = await readWorkspaceRecord(ref);
    observations.push({
      attempt: loadState(ref)?.attempt ?? -1,
      workspace: opts.projectDir,
      previous,
      fallback,
      continuation: opts.continuation,
      stageLeaf: record?.location.kind === 'staged-copy' ? record.location.leaf : null,
      stageUnchanged: stageBefore === null ? null : opts.projectDir === stageBefore,
    });
    writeFileSync(path, `${previous ?? ''}entry-${entryNumber}\n`);
    stop.abort();
    return { success: false, output: '', outcome: 'user-abort' as const };
  };
  await runWorkflow({
    prepared: makePreparedExecution({
      ...ref,
      feature: COLD_FEATURE,
      config,
      ...(saved === undefined ? {} : { resumeState: saved }),
    }),
    ...(saved === undefined ? {} : { savedState: saved }),
    callbacks: makeCallbacks().callbacks,
    sinks: TEST_SINKS,
    signal: stop.signal,
    eventBus: bus,
    _planner: planner,
    _implementer: makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: async (opts) =>
        entryNumber === 0 && route !== 'initial'
          ? route === 'hint'
            ? { success: false, output: 'Need advice', outcome: 'no-staged-change' as const }
            : { success: false, output: '', error: 'initial failure' }
          : writeAndStop(opts),
      retry: writeAndStop,
    }),
  });
  assertUnborn(projectDir);
  const state = loadState(ref);
  if (state === null) throw new Error('missing saved workflow');
  const recordAfter = await readWorkspaceRecord(ref);
  return {
    observations,
    state,
    stage:
      recordAfter?.location.kind === 'staged-copy'
        ? retainedStagedDirectory(ref, recordAfter)
        : null,
    logPath: join(sessionDir(projectDir, sessionId), 'session.jsonl'),
  };
}

async function readColdEndFixture(
  dir: string | undefined,
  sessionId: string,
): Promise<{ projectDir: string; state: WorkflowState } | null> {
  if (dir === undefined) return null;
  const ref = { projectDir: dir, sessionId };
  const state = loadState(ref);
  if (state === null || !existsSync(sessionDir(dir, sessionId))) return null;
  const record = await readWorkspaceRecord(ref);
  const stage =
    record?.location.kind === 'staged-copy' ? retainedStagedDirectory(ref, record) : null;
  if (
    state.closed !== undefined ||
    state.pendingRecovery !== undefined ||
    state.awaitingContinue !== true ||
    state.interruptedStep?.step.kind !== 'brief' ||
    state.tasks.length === 0 ||
    state.tasks[state.currentTaskIndex]?.status !== 'in_progress' ||
    record?.retained !== true ||
    stage === null ||
    !existsSync(join(stage, 'partial.ts'))
  )
    return null;
  return { projectDir: dir, state };
}

it.skipIf(!matrixActive)(
  `cold ${proofRoute} route entry ${proofEntry} keeps the shared stage, bytes, attempt, and log`,
  async () => {
    if (proofDir === undefined) throw new Error('Set F2B_PROOF_DIR');
    if (!Number.isInteger(proofEntry) || proofEntry < 0) throw new Error('Set F2B_PROOF_ENTRY');
    if (proofEntry === 0) execFileSync('git', ['init', '--quiet'], { cwd: proofDir });
    const task = makeColdTask();
    const { observations, state, stage, logPath } = await runColdEntry({
      projectDir: proofDir,
      entryNumber: proofEntry,
      route: proofRoute,
    });
    const expectedAttempt = proofRoute === 'initial' ? 0 : 1;
    expect(state).toMatchObject({
      phase: proofRoute === 'hint' && proofEntry === 0 ? 'escalating' : 'implementing',
      attempt: expectedAttempt,
      awaitingContinue: true,
      interruptedStep: {
        cut: 'mid-step',
        step: { kind: 'brief', taskId: task.id, attempt: expectedAttempt },
      },
      tasks: [{ status: 'in_progress' }],
    });
    expect(state.pendingRecovery).toBeUndefined();
    expect(existsSync(join(proofDir, 'partial.ts'))).toBe(false);
    expect(observations).toHaveLength(1);
    const observation = observations[0];
    if (observation === undefined) throw new Error('missing cold observation');
    expect(observation.previous).toBe(
      proofEntry === 0
        ? null
        : Array.from({ length: proofEntry }, (_, i) => `entry-${i}\n`).join(''),
    );
    expect(observation.attempt).toBe(expectedAttempt);
    expect(observation.fallback).toBe(true);
    if (stage === null) throw new Error('missing retained stage');
    expect(observation.workspace).toBe(stage);
    expect(observation.stageLeaf).not.toBeNull();
    expect(existsSync(join(stage, '.git'))).toBe(false);
    expect(existsSync(join(stage, '.splitbrief', 'sessions'))).toBe(false);
    expect(readFileSync(join(stage, 'partial.ts'), 'utf8')).toBe(
      Array.from({ length: proofEntry + 1 }, (_, i) => `entry-${i}\n`).join(''),
    );
    if (proofEntry > 0) {
      expect(observation.stageUnchanged).toBe(true);
      expect(observation.continuation?.partial).toBe('');
      expect(observation.continuation?.extra).toContain('partial.ts');
      expect(observation.continuation?.steer).toBeUndefined();
    } else {
      expect(observation.stageUnchanged).not.toBe(false);
      expect(observation.continuation).toBeUndefined();
    }
    expect(logPath.startsWith(proofDir)).toBe(true);
    expect(existsSync(logPath)).toBe(true);
    const replay = await readRunEvents({ projectDir: proofDir, sessionId: COLD_SESSION });
    expect(replay.events.filter((event) => event.type === 'workflow_resumed')).toHaveLength(
      proofEntry,
    );
    const result = {
      case: 'cold-process-entry',
      route: proofRoute,
      pid: process.pid,
      entryNumber: proofEntry,
      observations,
      stage,
      stateRevision: state.stateRevision,
      logPath,
    };
    mkdirSync(join(proofDir, '.splitbrief'), { recursive: true });
    writeFileSync(
      join(proofDir, '.splitbrief', `validator-entry-${proofEntry}.json`),
      JSON.stringify(result),
    );
    if (proofRoute !== 'initial') {
      writeFileSync(
        join(proofDir, '.splitbrief', `validator-${proofRoute}-entry-${proofEntry}.json`),
        JSON.stringify(result),
      );
    }
    console.log(JSON.stringify(result));
  },
  30_000,
);

it('cold retirement keeps resumed bytes, a bounded receipt, and revoked handles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cold-retirement-'));
  roots.push(root);
  const projectDir = join(root, 'project');
  mkdirSync(projectDir);
  execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
  const sessionId = 'retained-retirement';
  ensureSessionDir(projectDir, sessionId);
  const ref = { projectDir, sessionId };
  const task = makeColdTask();
  const config = makeColdConfig();
  const owner = workspaceOwner({ task, attempt: 0, config });
  const resumes = {
    role: 'implementer' as const,
    config,
    writesFiles: 'direct' as const,
    owner,
    resume: true,
  };
  const makeIsolation = () =>
    createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'staged-copy',
      onFallback: () => {},
      onRetained: () => {},
    });

  const first = makeIsolation();
  const firstWorkspace = await first.acquire({ ...resumes, resume: false });
  writeFileSync(join(firstWorkspace.projectDir, 'partial.ts'), 'entry-0\n');
  await firstWorkspace.retain?.();
  await first.dispose();
  const firstRecord = await readWorkspaceRecord(ref);
  if (firstRecord?.location.kind !== 'staged-copy') throw new Error('missing staged record');
  const firstLeaf = firstRecord.location.leaf;

  const resumed = makeIsolation();
  const resumedWorkspace = await resumed.acquire(resumes);
  expect(resumedWorkspace.projectDir).toBe(firstWorkspace.projectDir);
  expect(readFileSync(join(resumedWorkspace.projectDir, 'partial.ts'), 'utf8')).toBe('entry-0\n');
  writeFileSync(join(resumedWorkspace.projectDir, 'partial.ts'), 'entry-0\nentry-1\n');
  await resumedWorkspace.retain?.();
  await resumed.dispose();

  const successor = makeIsolation();
  const successorWorkspace = await successor.acquire({
    ...resumes,
    owner: { ...owner, attempt: 1 },
  });
  expect(successorWorkspace.projectDir).not.toBe(firstWorkspace.projectDir);

  const receiptName = `preserved-${firstLeaf}.json`;
  const preservedReceipts = readdirSync(sessionDir(projectDir, sessionId)).filter((name) =>
    name.startsWith('preserved-'),
  );
  expect(preservedReceipts).toEqual([receiptName]);
  const receiptPath = join(sessionDir(projectDir, sessionId), receiptName);
  const receiptStat = statSync(receiptPath);
  expect(receiptStat.mode & 0o777).toBe(0o600);
  expect(receiptStat.size).toBeLessThan(4096);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
    version: number;
    disposition: string;
    location: { leaf: string };
    directory: unknown;
  };
  expect(receipt.disposition).toBe('manual-removal');
  expect(receipt.location.leaf).toBe(firstLeaf);
  expect(Object.keys(receipt).sort()).toEqual(['directory', 'disposition', 'location', 'version']);
  expect(readFileSync(join(firstWorkspace.projectDir, 'partial.ts'), 'utf8')).toBe(
    'entry-0\nentry-1\n',
  );

  const successors = await readWorkspaceRecord(ref);
  if (successors?.location.kind !== 'staged-copy') throw new Error('missing successor record');
  expect(successors.retained).toBe(false);
  expect(successors.owner.attempt).toBe(1);
  expect(successors.location.leaf).not.toBe(firstLeaf);

  await expect(resumedWorkspace.retain?.()).rejects.toThrow('automatic continuation is blocked');
  await expect(resumed.acquire(resumes)).rejects.toThrow('automatic continuation is blocked');
  const later = makeIsolation();
  await expect(later.acquire(resumes)).rejects.toThrow('automatic continuation is blocked');
  await later.dispose();
  await successor.dispose();

  console.log(
    JSON.stringify({
      case: 'cold-retirement',
      pid: process.pid,
      stage: firstWorkspace.projectDir,
      successorStage: successorWorkspace.projectDir,
      receipt: receiptName,
      workerBytes: readFileSync(join(firstWorkspace.projectDir, 'partial.ts'), 'utf8'),
      successorAttempt: successors.owner.attempt,
      oldHandleRetain: 'automatic continuation is blocked',
    }),
  );
});

it.skipIf(!proofMainEnd)(
  'MAIN: the inline user-edit End on a cold retained resume closes once and stays terminal',
  async () => {
    const sessionId = COLD_SESSION;
    const parkFresh = async (dir: string): Promise<WorkflowState> => {
      execFileSync('git', ['init', '--quiet'], { cwd: dir });
      const parked = await runColdEntry({ projectDir: dir, entryNumber: 0, route: 'initial' });
      return parked.state;
    };

    const fixture = await readColdEndFixture(proofDir, sessionId);
    let projectDir = fixture?.projectDir;
    let saved = fixture?.state;
    if (projectDir === undefined || saved === undefined) {
      projectDir = mkdtempSync(join(tmpdir(), 'cold-end-'));
      roots.push(projectDir);
      saved = await parkFresh(projectDir);
    }
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    const record = await readWorkspaceRecord(ref);
    if (record?.location.kind !== 'staged-copy' || record.retained !== true)
      throw new Error('cold End requires a retained staged copy');
    const stage = retainedStagedDirectory(ref, record);
    if (stage === null) throw new Error('cold End requires a staged copy path');
    const workerBytes = readFileSync(join(stage, 'partial.ts'), 'utf8');
    expect(workerBytes.length).toBeGreaterThan(0);

    writeFileSync(join(projectDir, 'partial.ts'), 'operator edit\n');

    const canonicalStateFile = join(realpathSync(sessionDir(projectDir, sessionId)), STATE_FILE);

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    const captured: {
      closeBytes: string | null;
      closeMtimeMs: number | null;
      revisionAtClose: number | null;
      revisionAtAnswer: number | null;
      conflict: { files: string[]; actions: string[] } | null;
    } = {
      closeBytes: null,
      closeMtimeMs: null,
      revisionAtClose: null,
      revisionAtAnswer: null,
      conflict: null,
    };
    let answerCalls = 0;
    let implementerCalls = 0;
    bus.subscribe((event) => {
      events.push(event);
      if (event.type === 'workflow_cancelled' && captured.closeBytes === null) {
        captured.closeBytes = readFileSync(canonicalStateFile, 'utf8');
        captured.closeMtimeMs = statSync(canonicalStateFile).mtimeMs;
        captured.revisionAtClose = loadState(ref)?.stateRevision ?? -1;
      }
    });

    await runWorkflow({
      prepared: makePreparedExecution({
        ...ref,
        feature: COLD_FEATURE,
        config: makeColdConfig(),
        resumeState: saved,
      }),
      savedState: saved,
      callbacks: makeCallbacks({
        onUserEditConflict: async (conflict) => {
          answerCalls += 1;
          captured.conflict = {
            files: [...conflict.files],
            actions: [...conflict.availableActions],
          };
          captured.revisionAtAnswer = loadState(ref)?.stateRevision ?? -1;
          return 'abort-workflow' as const;
        },
      }).callbacks,
      sinks: TEST_SINKS,
      eventBus: bus,
      _planner: makePlanner({
        typedCall: typedCallFromTasks([makeColdTask()]),
      }),
      _implementer: makeImplementer({
        capabilities: { writesFiles: 'direct' },
        implement: vi.fn(async () => {
          implementerCalls += 1;
          return { success: false, output: '', outcome: 'user-abort' as const };
        }),
        retry: vi.fn(async () => {
          implementerCalls += 1;
          return { success: false, output: '', outcome: 'user-abort' as const };
        }),
      }),
    });

    if (
      captured.closeBytes === null ||
      captured.closeMtimeMs === null ||
      captured.revisionAtClose === null ||
      captured.revisionAtAnswer === null
    )
      throw new Error('the inline user-edit answer did not close the run');
    const closeBytes = captured.closeBytes;
    const closeMtimeMs = captured.closeMtimeMs;
    const revisionAtClose = captured.revisionAtClose;
    const revisionAtAnswer = captured.revisionAtAnswer;
    const observedConflict = captured.conflict;
    const finalState = loadState(ref);
    if (finalState === null) throw new Error('missing final state');

    expect(readFileSync(canonicalStateFile, 'utf8')).toBe(closeBytes);
    expect(finalState.stateRevision).toBe(revisionAtClose);
    expect(revisionAtClose).toBe(revisionAtAnswer + 1);
    // The closed record is not written again after the answer: neither its bytes nor
    // its inode's mtime move once disposal has run.
    expect(statSync(canonicalStateFile).mtimeMs).toBe(closeMtimeMs);
    expect(answerCalls).toBe(1);
    expect(observedConflict?.files).toContain('partial.ts');
    expect(observedConflict?.actions).toContain('abort-workflow');
    expect(implementerCalls).toBe(0);
    expect(finalState.closed?.as).toBe('ended');
    expect(finalState.pendingRecovery).toBeUndefined();
    expect(finalState.interruptedStep).toBeUndefined();
    expect(finalState.currentTaskIndex).toBe(0);
    expect(finalState.tasks).toMatchObject([{ status: 'in_progress' }]);
    expect(readRunRecord(ref)?.status).toEqual({ kind: 'closed', as: 'ended' });
    expect(readSession(ref)?.status).toBe('ended');

    const cancellations = events.filter((event) => event.type === 'workflow_cancelled');
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]).toMatchObject({ reason: WORKFLOW_CANCEL_REASON_USER });
    expect(events.filter((event) => event.type === 'recovery_prompted')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'task_started')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'paused_external_changes')).toMatchObject([
      { selectedAction: 'abort-workflow' },
    ]);
    const replay = await readRunEvents(ref);
    expect(replay.events.filter((event) => event.type === 'workflow_cancelled')).toHaveLength(1);

    expect(readFileSync(canonicalStateFile, 'utf8')).toBe(closeBytes);
    expect(statSync(canonicalStateFile).mtimeMs).toBe(closeMtimeMs);

    const recordAfterClose = await readWorkspaceRecord(ref);
    expect(recordAfterClose?.retained).toBe(true);
    const stageAfterClose =
      recordAfterClose === null ? null : retainedStagedDirectory(ref, recordAfterClose);
    expect(stageAfterClose).toBe(stage);
    expect(readFileSync(join(stage, 'partial.ts'), 'utf8')).toBe(workerBytes);

    console.log(
      JSON.stringify({
        case: 'main-end-terminal',
        pid: process.pid,
        fixture: fixture === null ? 'fresh-park' : 'provided',
        stage,
        attempt: saved.attempt,
        answerCalls,
        implementerCalls,
        eventCounts: {
          workflow_cancelled: cancellations.length,
          recovery_prompted: 0,
          task_started: 0,
        },
        state: {
          revisionAtAnswer,
          revisionAtClose,
          revisionAfterDisposal: finalState.stateRevision,
          postCloseStateRewrite: statSync(canonicalStateFile).mtimeMs !== closeMtimeMs,
        },
        bytesAtClose: closeBytes.length,
        workerBytes: workerBytes.length,
      }),
    );
  },
  30_000,
);
