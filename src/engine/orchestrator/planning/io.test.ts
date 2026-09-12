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
import { readSpecFile, type SpecMetadata } from '../../../core/paths-io.js';
import {
  PLAN_FILE,
  RESEARCH_FILE,
  SPEC_FILE,
  TASKS_FILE,
  sessionDir,
} from '../../../core/paths.js';
import { formatTasks } from '../../spec/formatter.js';
import { persistPhases, readPersistedTasks, readTasksForApproval } from './io.js';
import type { PhaseResult, PlannerArtifactLogicalName } from '../../planners/types.js';
import {
  createTaskCompilationAttemptId,
  OwnedPlannerArtifactSchema,
} from '../../../core/schemas/task-compilation.js';
import { sha256Hex } from '../../../utils/sha256.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const tmpDirs: string[] = [];
const TEST_METADATA: SpecMetadata = {
  plannerTool: 'claude-code',
  plannerModel: 'opus',
  implementerTool: 'codex',
  implementerModel: 'gpt-5',
  mode: 'standard',
};

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

describe('readTasksForApproval', () => {
  it('rewrites tasks.md from current tasks when the file is missing', async () => {
    const wctx = makeTaskWorkflowContext();
    const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
    const tasksFilePath = join(sessionDir(ref.projectDir, ref.sessionId), TASKS_FILE);
    const currentTasks = [
      makeTask({
        id: 'T001',
        implementationSteps: ['Update the target module'],
        tests: ['focused tests pass'],
        evidence: ['test output captured'],
        scope: { inBounds: ['src/hello.ts'] },
      }),
    ];

    const result = await readTasksForApproval({
      tasksFilePath,
      currentTasks,
      projectDir: ref.projectDir,
      sessionId: ref.sessionId,
      metadata: TEST_METADATA,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected tasks.md to be rewritten from current tasks');
    expect(result.tasks.map((task) => task.id)).toEqual(['T001']);
    expect(existsSync(tasksFilePath)).toBe(true);
    const reread = await readPersistedTasks(tasksFilePath);
    expect(reread).toEqual({ ok: true, tasks: result.tasks });
  });

  it('surfaces missing when current tasks are empty', async () => {
    const wctx = makeTaskWorkflowContext();
    const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
    const tasksFilePath = join(sessionDir(ref.projectDir, ref.sessionId), TASKS_FILE);

    const result = await readTasksForApproval({
      tasksFilePath,
      currentTasks: [],
      projectDir: ref.projectDir,
      sessionId: ref.sessionId,
      metadata: TEST_METADATA,
    });

    expect(result).toMatchObject({ ok: false, reason: 'missing' });
    expect(existsSync(tasksFilePath)).toBe(false);
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
