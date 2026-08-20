import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import { ensureSessionDir, readSpecFile, writeSpecFile } from '../../../core/paths-io.js';
import { PLAN_FILE, SPEC_FILE, TASKS_FILE } from '../../../core/paths.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { REAL_TASKS_MD } from '#testing/helpers/planning-phase.js';
import { regeneratePlanAndTasks, regenerateTasks } from './regen.js';

let dirs: string[] = [];

function setupProjectDir(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('candidate-producers');
  dirs.push(projectDir);
  const sessionId = 'sess-candidate-producers';
  ensureSessionDir(projectDir, sessionId);
  writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nDraft.\n', null);
  writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan\n\nDraft.\n', null);
  return { projectDir, sessionId };
}

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('regenerateTasks returns a candidate', () => {
  it('parses the candidate without writing tasks.md', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    writeSpecFile(
      { projectDir, sessionId },
      TASKS_FILE,
      '# Authoritative Task Briefs\n\nPrior bytes stay.\n',
      TEST_METADATA,
    );
    const priorBytes = readSpecFile({ projectDir, sessionId }, TASKS_FILE);
    const planner = makePlanner({
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
    });

    const result = await regenerateTasks({
      projectDir,
      sessionId,
      planner,
      callbacks: makeCallbacks().callbacks,
      bus,
      state: createInitialState('feat'),
      metadata: TEST_METADATA,
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('T001');
    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toBe(priorBytes);
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
  });

  it('leaves the authoritative Tasks, quality, permit, and events untouched when parsing fails', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    writeSpecFile(
      { projectDir, sessionId },
      TASKS_FILE,
      '# Authoritative Task Briefs\n\nPrior bytes stay.\n',
      TEST_METADATA,
    );
    const priorBytes = readSpecFile({ projectDir, sessionId }, TASKS_FILE);
    const malformedTaskLikeBlock = `---
id: T002
title:
action: invalid
file:
depends_on: []
---

### Description
This replacement must fail strict parsing.
`;
    const planner = makePlanner({
      review: vi.fn().mockResolvedValue({
        text: malformedTaskLikeBlock,
        usage: { inputTokens: 31, outputTokens: 7 },
      }),
    });

    await expect(
      regenerateTasks({
        projectDir,
        sessionId,
        planner,
        callbacks: makeCallbacks().callbacks,
        bus,
        state: createInitialState('feat'),
        metadata: TEST_METADATA,
      }),
    ).rejects.toMatchObject({ kind: 'parse-tasks-invalid-block' });

    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toBe(priorBytes);
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
    expect(events.filter((event) => event.type.startsWith('brief_quality'))).toHaveLength(0);
    expect(events.filter((event) => event.type === 'brief_generation_published')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'brief_execution_permit_issued')).toHaveLength(
      0,
    );
    const persisted = loadState({ projectDir, sessionId });
    expect(persisted).not.toBeNull();
    if (persisted === null) throw new Error('expected usage state to be persisted');
    expect(persisted.tokenUsage).toMatchObject({ plannerInput: 31, plannerOutput: 7 });
  });
});

describe('regeneratePlanAndTasks returns candidates', () => {
  it('projects the regenerated plan as an approval document while tasks.md stays untouched', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    writeSpecFile(
      { projectDir, sessionId },
      TASKS_FILE,
      '# Authoritative Task Briefs\n\nPrior bytes stay.\n',
      TEST_METADATA,
    );
    const priorTasksBytes = readSpecFile({ projectDir, sessionId }, TASKS_FILE);
    const priorPlanBytes = readSpecFile({ projectDir, sessionId }, PLAN_FILE);
    const planner = makePlanner({
      review: vi
        .fn()
        .mockResolvedValueOnce({ text: '# Plan\n\nRegenerated.\n', usage: null })
        .mockResolvedValueOnce({ text: REAL_TASKS_MD, usage: null }),
    });

    const result = await regeneratePlanAndTasks({
      projectDir,
      sessionId,
      planner,
      callbacks: makeCallbacks().callbacks,
      bus,
      state: createInitialState('feat'),
      metadata: TEST_METADATA,
    });

    expect(result.tasks).toHaveLength(1);
    expect(readSpecFile({ projectDir, sessionId }, PLAN_FILE)).not.toBe(priorPlanBytes);
    expect(readSpecFile({ projectDir, sessionId }, PLAN_FILE)).toContain('# Plan\n\nRegenerated.');
    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toBe(priorTasksBytes);
    expect(
      events.filter((event) => event.type === 'artifact_written').map((event) => event.filename),
    ).toEqual([PLAN_FILE]);
  });

  it('preserves Tasks, quality, permit, and events when task regeneration fails after plan regeneration', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    writeSpecFile(
      { projectDir, sessionId },
      TASKS_FILE,
      '# Authoritative Task Briefs\n\nPrior bytes stay.\n',
      TEST_METADATA,
    );
    const priorTasksBytes = readSpecFile({ projectDir, sessionId }, TASKS_FILE);
    const planner = makePlanner({
      review: vi
        .fn()
        .mockResolvedValueOnce({ text: '# Plan\n\nRegenerated.\n', usage: null })
        .mockRejectedValueOnce(new Error('task regeneration failed')),
    });

    await expect(
      regeneratePlanAndTasks({
        projectDir,
        sessionId,
        planner,
        callbacks: makeCallbacks().callbacks,
        bus,
        state: createInitialState('feat'),
        metadata: TEST_METADATA,
      }),
    ).rejects.toThrow('task regeneration failed');

    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toBe(priorTasksBytes);
    expect(
      events.filter((event) => event.type === 'artifact_written').map((event) => event.filename),
    ).toEqual([PLAN_FILE]);
    expect(events.filter((event) => event.type.startsWith('brief_quality'))).toHaveLength(0);
    expect(events.filter((event) => event.type === 'brief_generation_published')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'brief_execution_permit_issued')).toHaveLength(
      0,
    );
  });

  it('preserves the authoritative Tasks, plan, quality, permit, and events when plan regeneration fails', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    writeSpecFile(
      { projectDir, sessionId },
      TASKS_FILE,
      '# Authoritative Task Briefs\n\nPrior bytes stay.\n',
      TEST_METADATA,
    );
    const priorTasksBytes = readSpecFile({ projectDir, sessionId }, TASKS_FILE);
    const priorPlanBytes = readSpecFile({ projectDir, sessionId }, PLAN_FILE);
    const planner = makePlanner({
      review: vi.fn().mockRejectedValue(new Error('plan regeneration failed')),
    });

    await expect(
      regeneratePlanAndTasks({
        projectDir,
        sessionId,
        planner,
        callbacks: makeCallbacks().callbacks,
        bus,
        state: createInitialState('feat'),
        metadata: TEST_METADATA,
      }),
    ).rejects.toThrow('plan regeneration failed');

    expect(readSpecFile({ projectDir, sessionId }, PLAN_FILE)).toBe(priorPlanBytes);
    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toBe(priorTasksBytes);
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
    expect(events.filter((event) => event.type.startsWith('brief_quality'))).toHaveLength(0);
    expect(events.filter((event) => event.type === 'brief_generation_published')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'brief_execution_permit_issued')).toHaveLength(
      0,
    );
  });
});
