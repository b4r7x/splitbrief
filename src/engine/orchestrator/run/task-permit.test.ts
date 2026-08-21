import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIEF_QUALITY_FILE, TASKS_FILE } from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import type { BriefGenerationRef, TaskExecutionPermit } from '../../../core/schemas/brief-owner.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { saveState } from '../../../core/state/persistence.js';
import type { StateAuthorityReceipt } from '../../../core/state/types.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { evaluateBriefQuality } from '../../spec/brief-quality.js';
import { formatTasks } from '../../spec/formatter.js';
import { parseTasksStrict } from '../../spec/tasks/parse.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { planningResultForState } from '../planning/handoff.js';
import { readWorkflowStateHead } from '../state-ops.js';
import type { PlanningPhaseResult } from '../planning/types.js';
import { attachWorkflowAuthority } from './init.js';
import { runTasksAndReview } from './task-execution.js';

type Fixture = {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  planning: Extract<PlanningPhaseResult, { disposition: 'ready-for-tasks' }>;
  implementer: ReturnType<typeof makeImplementer>;
  events: ReturnType<typeof makeBusRecorder>['events'];
  authority: StateAuthorityReceipt;
};

const taskOverrides = {
  scope: { inBounds: ['src/hello.ts'] },
  evidence: ['The greeting module is present and exports the requested function.'],
  typeDefs: 'export function hello(): string;',
} satisfies Partial<Task>;

let projects: string[] = [];

afterEach(() => {
  for (const projectDir of projects) cleanupTempDir(projectDir);
  projects = [];
});

function makeFixture(options: { warning?: boolean } = {}): Fixture {
  const project = setupGitSessionProject({
    prefix: 'task-permit-test',
    sessionId: 'sess-task-permit',
  });
  projects.push(project.projectDir);
  const ref = { projectDir: project.projectDir, sessionId: project.sessionId };
  const task = makeTask({ ...taskOverrides, ...(options.warning ? { typeDefs: '' } : {}) });
  const tasksText = formatTasks([task]);
  writeSpecFile(ref, TASKS_FILE, tasksText, null);
  const persistedTasks = parseTasksStrict(tasksText);
  const tasksBytesDigest = sha256Hex(tasksText);
  const quality = evaluateBriefQuality(persistedTasks);
  const qualityText = JSON.stringify(
    {
      ...quality,
      briefHash: tasksBytesDigest,
      ruleVersion: 'brief-quality-v1',
    },
    null,
    2,
  );
  writeSpecFile(ref, BRIEF_QUALITY_FILE, qualityText, null);

  const base = makeImplState(persistedTasks);
  const recovery = base.briefRecovery;
  if (
    recovery === undefined ||
    recovery === null ||
    recovery.status !== 'ready' ||
    recovery.matchingReport === null
  ) {
    throw new Error('Expected a normal ready Brief recovery fixture.');
  }
  const qualityDigest = sha256Hex(qualityText);
  const nextRecovery = {
    ...recovery,
    activeBrief: { ...recovery.activeBrief, hash: tasksBytesDigest, path: TASKS_FILE, revision: 1 },
    matchingReport: {
      ...recovery.matchingReport,
      briefHash: tasksBytesDigest,
      issues: quality.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        taskId: issue.taskId,
        message: issue.message,
      })),
      report: {
        ...recovery.matchingReport.report,
        hash: qualityDigest,
        path: BRIEF_QUALITY_FILE,
        revision: 1,
      },
    },
  };
  const authorityRevision = base.authorityRevision ?? 1;
  const generation: BriefGenerationRef = {
    generationId: `brief-${recovery.epochId}-${sha256Hex(JSON.stringify(persistedTasks)).slice(0, 16)}`,
    manifestDigest: sha256Hex(
      JSON.stringify(
        persistedTasks.map((currentTask) => ({
          id: currentTask.id,
          file: currentTask.file,
          action: currentTask.action,
          dependsOn: currentTask.dependsOn,
        })),
      ),
    ),
    tasksDigest: sha256Hex(JSON.stringify(persistedTasks)),
    qualityDigest,
    programId: null,
  };
  const permit: TaskExecutionPermit = {
    version: 1,
    epochId: recovery.epochId,
    authorityRevision,
    generationId: generation.generationId,
    manifestDigest: generation.manifestDigest,
    tasksDigest: generation.tasksDigest,
    qualityDigest,
    approvalEvidence: {
      revision: 1,
      hash: qualityDigest,
      path: BRIEF_QUALITY_FILE,
    },
    issuedAt: '2026-08-15T00:00:00.000Z',
  };
  const state: WorkflowState = {
    ...base,
    briefRecovery: nextRecovery,
    generation,
    permit,
    stateFence: { token: 1, ownerId: 'task-permit-test-owner' },
    authorityRevision,
  };
  saveState(ref, state);
  const head = readWorkflowStateHead(ref);
  if (head === null) throw new Error('Expected a persisted workflow state head.');
  const authority: StateAuthorityReceipt = {
    kind: 'usable',
    sessionId: project.sessionId,
    ownerId: state.stateFence?.ownerId ?? 'task-permit-test-owner',
    pid: process.pid,
    processStart: 'task-permit-test-process',
    runId: 'task-permit-test-run',
    acquisitionId: 'task-permit-test-acquisition',
    fence: state.stateFence?.token ?? 0,
    stateRevision: head.state.stateRevision ?? 0,
    stateDigest: head.digest,
  };

  const implementer = makeImplementer();
  const planning = planningResultForState({ sessionId: project.sessionId, state });
  if (planning.disposition !== 'ready-for-tasks') {
    throw new Error('Expected a ready planning handoff fixture.');
  }
  return {
    ...project,
    state,
    planning,
    implementer,
    events: [],
    authority,
  };
}

async function runFixture(
  fixture: Fixture,
  planning = fixture.planning,
  options: { authority?: StateAuthorityReceipt; attachAuthority?: boolean } = {},
) {
  const { projectDir, sessionId, state, implementer, events } = fixture;
  const recorder = makeBusRecorder();
  const callbacks = makeCallbacks();
  const wctx = makeWctx({
    projectDir,
    sessionId,
    config: makeNoValidationConfig({ workflow: {} }),
    callbacks: callbacks.callbacks,
    bus: recorder.bus,
    implementer,
    planner: makePlanner(),
  });
  if (options.attachAuthority !== false) {
    attachWorkflowAuthority(wctx, options.authority ?? fixture.authority);
  }
  const result = await runTasksAndReview({
    wctx,
    state,
    planning,
    summaryBase: {
      feature: 'feat',
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    },
    phaseTimings: {},
    setTrackedState: vi.fn(),
    setCurrentTask: vi.fn(),
  });
  events.push(...recorder.events);
  return result;
}

function hasLegacyApprovalWarning(events: Fixture['events']): boolean {
  return events.some(
    (event) => event.type === 'warning' && event.code === 'approval_prompt_not_restored',
  );
}

describe('task execution permit revalidation', { timeout: 90_000 }, () => {
  it('makes zero implementer calls for a planning Task impostor with identical metadata', async () => {
    const fixture = makeFixture();
    const impostor = makeTask({ ...taskOverrides, title: 'Substituted planning task' });
    const planning = { ...fixture.planning, tasks: [impostor] };

    await runFixture(fixture, planning);

    expect(fixture.implementer.implement).not.toHaveBeenCalled();
    expect(hasLegacyApprovalWarning(fixture.events)).toBe(false);
  });

  it('makes zero implementer calls for substituted persisted Task bytes', async () => {
    const fixture = makeFixture();
    const ref = { projectDir: fixture.projectDir, sessionId: fixture.sessionId };
    const impostor = makeTask({ ...taskOverrides, title: 'Substituted persisted task' });
    writeSpecFile(ref, TASKS_FILE, formatTasks([impostor]), null);

    await runFixture(fixture);

    expect(fixture.implementer.implement).not.toHaveBeenCalled();
    expect(hasLegacyApprovalWarning(fixture.events)).toBe(false);
  });

  it('makes zero implementer calls when the fenced owner head is stale', async () => {
    const fixture = makeFixture();
    saveState(
      { projectDir: fixture.projectDir, sessionId: fixture.sessionId },
      { ...fixture.state, feature: 'stale owner head' },
    );

    await runFixture(fixture);

    expect(fixture.implementer.implement).not.toHaveBeenCalled();
    expect(hasLegacyApprovalWarning(fixture.events)).toBe(false);
  });

  it('makes exactly one implementer call for the current persisted permit', async () => {
    const fixture = makeFixture();

    await runFixture(fixture);

    expect(fixture.implementer.implement).toHaveBeenCalledTimes(1);
    expect(hasLegacyApprovalWarning(fixture.events)).toBe(false);
  });

  it('makes exactly one implementer call for an owner-issued permit with warning issues', async () => {
    const fixture = makeFixture({ warning: true });

    await runFixture(fixture);

    expect(fixture.implementer.implement).toHaveBeenCalledTimes(1);
    expect(hasLegacyApprovalWarning(fixture.events)).toBe(false);
  });

  it('makes zero implementer calls when the owner authority receipt is missing', async () => {
    const fixture = makeFixture();

    await runFixture(fixture, fixture.planning, { attachAuthority: false });

    expect(fixture.implementer.implement).not.toHaveBeenCalled();
    expect(hasLegacyApprovalWarning(fixture.events)).toBe(false);
  });

  it('makes zero implementer calls when the owner authority fence is stale', async () => {
    const fixture = makeFixture();

    await runFixture(fixture, fixture.planning, {
      authority: { ...fixture.authority, fence: fixture.authority.fence + 1 },
    });

    expect(fixture.implementer.implement).not.toHaveBeenCalled();
    expect(hasLegacyApprovalWarning(fixture.events)).toBe(false);
  });

  it('makes zero implementer calls for invalid persisted Task bytes', async () => {
    const fixture = makeFixture();
    const ref = { projectDir: fixture.projectDir, sessionId: fixture.sessionId };
    writeSpecFile(ref, TASKS_FILE, '', null);

    await runFixture(fixture);

    expect(fixture.implementer.implement).not.toHaveBeenCalled();
    expect(hasLegacyApprovalWarning(fixture.events)).toBe(false);
  });
});
