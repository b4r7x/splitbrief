import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import { ensureSessionDir, readSpecFile, writeSpecFile } from '../../../core/paths-io.js';
import { PLAN_FILE, SPEC_FILE, TASKS_FILE, sessionDir } from '../../../core/paths.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTestSinks, REAL_TASKS_MD } from '#testing/helpers/planning-phase.js';
import { formatTasks } from '../../spec/formatter.js';
import { regenerateTasks } from './regen.js';

let dirs: string[] = [];

function setupProjectDir(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('regen-test');
  dirs.push(projectDir);
  const sessionId = 'sess-regen';
  ensureSessionDir(projectDir, sessionId);
  writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nDraft.\n', null);
  writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan\n\nDraft.\n', null);
  return { projectDir, sessionId };
}

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('regenerateTasks', () => {
  it('compiles the prompt from the tasks.md on disk, not the stale in-memory state.tasks', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus } = makeBusRecorder();

    const onDisk = makeTask({ id: 'T001', title: 'Disk version of the brief' });
    const stale = makeTask({ id: 'T001', title: 'Stale in-memory brief' });
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, formatTasks([onDisk]), TEST_METADATA);
    const priorTasksBytes = readSpecFile({ projectDir, sessionId }, TASKS_FILE);

    let seenPrompt = '';
    const planner = makePlanner({
      review: async (prompt: string) => {
        seenPrompt = prompt;
        return { text: formatTasks([onDisk]), usage: null };
      },
    });

    const state = { ...createInitialState('feat'), tasks: [stale] };

    await regenerateTasks({
      projectDir,
      sessionId,
      planner,
      callbacks: makeCallbacks().callbacks,
      bus,
      state,
      metadata: TEST_METADATA,
    });

    expect(seenPrompt).toContain('Disk version of the brief');
    expect(seenPrompt).not.toContain('Stale in-memory brief');
    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toBe(priorTasksBytes);
  });

  it('carries the skills context into the tasks prompt', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus } = makeBusRecorder();

    const onDisk = makeTask({ id: 'T001', title: 'Disk version of the brief' });
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, formatTasks([onDisk]), TEST_METADATA);

    let seenPrompt = '';
    const planner = makePlanner({
      review: async (prompt: string) => {
        seenPrompt = prompt;
        return { text: formatTasks([onDisk]), usage: null };
      },
    });

    await regenerateTasks({
      projectDir,
      sessionId,
      planner,
      callbacks: makeCallbacks().callbacks,
      bus,
      state: createInitialState('feat'),
      metadata: TEST_METADATA,
      skillsContext: '## Active Project Skills\n\n### AuthSkill\nREGEN-SKILL-BODY',
    });

    expect(seenPrompt).toContain('## Active Project Skills');
    expect(seenPrompt).toContain('REGEN-SKILL-BODY');
  });

  it('falls back to state.tasks when tasks.md is absent on disk', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus } = makeBusRecorder();

    const inMemory = makeTask({ id: 'T001', title: 'Only-in-memory brief' });

    let seenPrompt = '';
    const planner = makePlanner({
      review: async (prompt: string) => {
        seenPrompt = prompt;
        return { text: formatTasks([inMemory]), usage: null };
      },
    });

    const state = { ...createInitialState('feat'), tasks: [inMemory] };

    await regenerateTasks({
      projectDir,
      sessionId,
      planner,
      callbacks: makeCallbacks().callbacks,
      bus,
      state,
      metadata: TEST_METADATA,
    });

    expect(seenPrompt).toContain('Only-in-memory brief');
    expect(existsSync(join(sessionDir(projectDir, sessionId), TASKS_FILE))).toBe(false);
  });

  it('warns on the bus when regenerated Task Briefs contain an unknown ### section (F-429 / N399)', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();

    const regeneratedWithUnknownSection = `${REAL_TASKS_MD}
### Future Considerations

- this heading is outside the canonical grammar and will be dropped
`;
    const planner = makePlanner({
      review: async () => ({ text: regeneratedWithUnknownSection, usage: null }),
    });

    const state = createInitialState('feat');

    const result = await regenerateTasks({
      projectDir,
      sessionId,
      planner,
      callbacks: makeCallbacks().callbacks,
      bus,
      state,
      metadata: TEST_METADATA,
    });

    expect(result.tasks).toHaveLength(1);
    const warning = events.find(
      (e) => e.type === 'warning' && e.message.includes('Future Considerations'),
    );
    expect(warning).toBeDefined();
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
  });

  it('names the tasks call it opens, so the byline counts the regeneration as that call', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
    });

    await regenerateTasks({
      projectDir,
      sessionId,
      planner,
      callbacks: makeCallbacks().callbacks,
      bus,
      state: { ...createInitialState('feat'), phase: 'reviewing-briefs' },
      metadata: TEST_METADATA,
      statusPhase: 'planning',
    });

    const statuses = events.flatMap((event) =>
      event.type === 'planner_status'
        ? [{ phase: event.phase, status: event.status, call: event.call }]
        : [],
    );
    expect(statuses).toEqual([
      { phase: 'planning', status: 'running', call: 'tasks' },
      { phase: 'planning', status: 'done', call: undefined },
    ]);
  });

  it('parses the candidate without writing tasks.md', async () => {
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
    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toBe(priorTasksBytes);
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
  });

  it('persists planner usage and leaves Tasks, quality, permit, and events untouched when strict Task Brief parsing rejects a replacement', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    writeSpecFile(
      { projectDir, sessionId },
      TASKS_FILE,
      '# Authoritative Task Briefs\n\nPrior bytes stay.\n',
      TEST_METADATA,
    );
    const priorTasksBytes = readSpecFile({ projectDir, sessionId }, TASKS_FILE);
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

    const persisted = loadState({ projectDir, sessionId });
    expect(persisted).not.toBeNull();
    if (persisted === null) throw new Error('expected usage state to be persisted');
    expect(persisted.tokenUsage).toMatchObject({ plannerInput: 31, plannerOutput: 7 });
    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toBe(priorTasksBytes);
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
    expect(events.filter((event) => event.type.startsWith('brief_quality'))).toHaveLength(0);
  });

  it('an abort during regeneration review parks the retry prompt instead of failing', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    const sinks = createTestSinks();
    const { callbacks } = makeCallbacks({
      onContinuationNeeded: async () => 'retry with more detail',
    });

    const regenerated = makeTask({ id: 'T001', title: 'Regenerated brief' });
    const prompts: string[] = [];
    const planner = makePlanner({
      review: async (prompt: string) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          sinks.abortTurn();
          throw new Error('aborted');
        }
        return { text: formatTasks([regenerated]), usage: null };
      },
    });

    const result = await regenerateTasks({
      projectDir,
      sessionId,
      planner,
      callbacks,
      bus,
      state: createInitialState('feat'),
      metadata: TEST_METADATA,
      sinks,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('retry with more detail');
    // The retry is the same regeneration prompt with the note on the end.
    expect(prompts[1]?.startsWith(prompts[0] ?? '')).toBe(true);
    expect(result.tasks).toHaveLength(1);
    expect(events.filter((e) => e.type === 'turn_interrupted')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
  });
});
