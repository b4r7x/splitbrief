import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
import { sessionDir } from '../../../src/core/paths.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import { createRunIsolation } from '../../../src/engine/orchestrator/isolation/create.js';
import {
  readWorkspaceRecord,
  retainedStagedDirectory,
  workspaceOwner,
} from '../../../src/engine/orchestrator/isolation/retention.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import {
  guidanceConsult,
  planFromTasks,
  typedCallPlanAndConsult,
} from '#testing/helpers/typed-planner.js';

// Cold-process proof harness. The host runs this file once per matrix cell:
//   F2B_PROOF_DIR=<fixture> F2B_PROOF_ENTRY=<n> F2B_PROOF_ROUTE=<initial|local|consult>
// Each cell is one independent process over the fixture; entries 0..2 keep the
// same retained stage, bytes, attempt, and canonical session log. Retirement is
// common to MAIN and CLONE.
type ColdRoute = 'initial' | 'local' | 'consult';

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
const proofRoute = coldRouteFromEnv();
const matrixActive = proofDir !== undefined && Number.isInteger(proofEntry) && proofEntry >= 0;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function coldRouteFromEnv(): ColdRoute {
  const raw = (process.env.F2B_PROOF_ROUTE ?? process.env.F2B_ROUTE ?? 'initial').toLowerCase();
  return raw === 'local' || raw === 'consult' ? raw : 'initial';
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
    typedCall: typedCallPlanAndConsult(
      () => planFromTasks([task]),
      () => guidanceConsult('Try the other marker.'),
    ),
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
          ? { success: false, output: '', error: `${route} initial failure` }
          : writeAndStop(opts),
      retry: async (opts) =>
        route === 'consult' && opts.kind === 'local'
          ? { success: false, output: '', error: 'the local retry needs the planner' }
          : writeAndStop(opts),
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
    const expectedAttempt = proofRoute === 'consult' ? 2 : proofRoute === 'initial' ? 0 : 1;
    expect(state).toMatchObject({
      phase: 'implementing',
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

it('cold continuation keeps one staged directory and revokes disposed handles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cold-continuation-'));
  roots.push(root);
  const projectDir = join(root, 'project');
  mkdirSync(projectDir);
  execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
  const sessionId = 'retained-continuation';
  ensureSessionDir(projectDir, sessionId);
  const ref = { projectDir, sessionId };
  const config = makeColdConfig();
  const options = { role: 'implementer' as const, config, resume: true };
  const makeIsolation = () =>
    createRunIsolation({
      ...ref,
      strategy: 'staged-copy',
      onFallback: () => {},
      onRetained: () => {},
    });
  const first = makeIsolation();
  const workspace = await first.acquire({ ...options, resume: false });
  writeFileSync(join(workspace.projectDir, 'partial.ts'), 'entry-0\n');
  await workspace.retain?.();
  await first.dispose();
  const resumed = makeIsolation();
  const continued = await resumed.acquire(options);
  expect(continued.projectDir).toBe(workspace.projectDir);
  expect(readFileSync(join(continued.projectDir, 'partial.ts'), 'utf8')).toBe('entry-0\n');
  writeFileSync(join(continued.projectDir, 'partial.ts'), 'entry-0\nentry-1\n');
  await continued.retain?.();
  await resumed.dispose();
  const successor = makeIsolation();
  const next = await successor.acquire(options);
  expect(next.projectDir).toBe(workspace.projectDir);
  expect(readFileSync(join(next.projectDir, 'partial.ts'), 'utf8')).toBe('entry-0\nentry-1\n');
  const record = await readWorkspaceRecord(ref);
  expect(record?.retained).toBe(false);
  expect(record?.owner).toEqual(workspaceOwner({ sessionId, config }));
  expect(
    readdirSync(sessionDir(projectDir, sessionId)).filter((name) => name.startsWith('preserved-')),
  ).toEqual([]);
  await expect(continued.retain?.()).rejects.toThrow('automatic continuation is blocked');
  await expect(resumed.acquire(options)).rejects.toThrow('automatic continuation is blocked');
  await successor.dispose();
});
