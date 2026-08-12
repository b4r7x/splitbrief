import { afterEach, describe, expect, it } from 'vitest';
import { linkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { readSpecFile, type SpecMetadata } from '../../../core/paths-io.js';
import { PLAN_FILE, RESEARCH_FILE, SPEC_FILE, TASKS_FILE } from '../../../core/paths.js';
import { formatTasks } from '../../spec/formatter.js';
import { persistPhases, readPersistedTasks } from './io.js';

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
    const researchPhase = { filename: RESEARCH_FILE, text: '# Research\n\nFindings.' };
    const specPhase = { filename: SPEC_FILE, text: '# Spec\n\nRequirements.' };
    const planPhase = { filename: PLAN_FILE, text: '# Plan\n\nSteps.' };
    const tasksPhase = { filename: TASKS_FILE, text: makeTasksMarkdown() };
    const phases = [researchPhase, specPhase, planPhase, tasksPhase];

    persistPhases({
      projectDir,
      sessionId,
      phases,
      metadata: TEST_METADATA,
      bus,
      phase: 'planning',
    });

    expect(readSpecFile({ projectDir, sessionId }, RESEARCH_FILE)).toBe(researchPhase.text);
    expect(readSpecFile({ projectDir, sessionId }, SPEC_FILE)).toContain(specPhase.text);
    expect(readSpecFile({ projectDir, sessionId }, PLAN_FILE)).toContain(planPhase.text);
    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toContain(tasksPhase.text);
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(phases.length);
    expect(
      events.filter((event) => event.type === 'artifact_written').map((event) => event.filename),
    ).toEqual(phases.map((phase) => phase.filename));
  });

  it('does not re-admit a spec phase that was validated by the planner', () => {
    const projectDir = createTempDir('planning-io-admitted');
    tmpDirs.push(projectDir);
    const { bus, events } = makeBusRecorder();

    persistPhases({
      projectDir,
      sessionId: 'persist-admitted',
      phases: [{ filename: SPEC_FILE, text: 'Planner-admitted prose without a heading.' }],
      metadata: TEST_METADATA,
      bus,
      phase: 'planning',
    });

    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(1);
    expect(readSpecFile({ projectDir, sessionId: 'persist-admitted' }, SPEC_FILE)).toContain(
      'Planner-admitted prose without a heading.',
    );
  });

  it('rejects an unknown phase artifact with a typed planning error', () => {
    const projectDir = createTempDir('planning-io-unknown-artifact');
    tmpDirs.push(projectDir);
    const { bus, events } = makeBusRecorder();

    expect(() =>
      persistPhases({
        projectDir,
        sessionId: 'persist-unknown',
        phases: [{ filename: 'artifact.txt', text: '# Unknown' }],
        metadata: TEST_METADATA,
        bus,
        phase: 'planning',
      }),
    ).toThrowError(
      expect.objectContaining({
        kind: 'planning-unknown-artifact',
        data: { filename: 'artifact.txt' },
      }),
    );
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
  });
});
