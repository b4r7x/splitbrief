import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { readSpecFile, type SpecMetadata } from '../../core/paths-io.js';
import { PLAN_FILE, TASKS_FILE } from '../../core/paths.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { writeAndPublishPlanArtifacts } from './artifact-write.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { specMetadataOf } from '../../core/providers/seat-identity.js';
import { formatSeatIdentity } from '../../core/crew/identity.js';

const SESSION_ID = 'artifact-write-test';
const METADATA: SpecMetadata = {
  planner: { tool: 'claude-code', model: 'opus' },
  implementer: { tool: 'codex', model: 'gpt-5' },
};

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir !== undefined) cleanupTempDir(tempDir);
  tempDir = undefined;
});

function fixtureDir(): string {
  tempDir = createTempDir('artifact-write-test');
  return tempDir;
}

const TASKS = Array.from({ length: 3 }, (_, index) =>
  makeTask({ id: `T00${index + 1}`, title: `Brief ${index + 1}` }),
);

describe('writeAndPublishPlanArtifacts', () => {
  it('writes the same kind-qualified identities to both plan artifacts', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'opencode',
        model: 'sonnet',
        apiBase: 'http://localhost:11434/v1',
      },
      implementer: { kind: 'api', provider: 'claude-code', model: 'sonnet' },
    });
    const projectDir = fixtureDir();
    const { bus } = makeBusRecorder();
    writeAndPublishPlanArtifacts({
      projectDir,
      sessionId: SESSION_ID,
      bus,
      phase: 'planning',
      metadata: specMetadataOf(config),
      planMarkdown: '# Plan\n\nSteps.',
      tasks: TASKS,
    });
    for (const filename of [PLAN_FILE, TASKS_FILE]) {
      const content = readSpecFile({ projectDir, sessionId: SESSION_ID }, filename);
      expect(content).toContain(`planner: ${formatSeatIdentity({ seat: config.planner })}\n`);
      expect(content).toContain(
        `implementer: ${formatSeatIdentity({ seat: config.implementer })}\n`,
      );
      expect(content).not.toContain('CLI');
    }
  });

  it('writes plan.md and tasks.md, then publishes one card for each', () => {
    const projectDir = fixtureDir();
    const { bus, events } = makeBusRecorder();

    writeAndPublishPlanArtifacts({
      projectDir,
      sessionId: SESSION_ID,
      bus,
      phase: 'planning',
      metadata: METADATA,
      planMarkdown: '# Plan\n\nSteps.',
      tasks: TASKS,
    });

    const ref = { projectDir, sessionId: SESSION_ID };
    expect(readSpecFile(ref, PLAN_FILE)).toContain('generated_by: splitbrief');
    expect(readSpecFile(ref, PLAN_FILE)).toContain('Steps.');
    expect(readSpecFile(ref, TASKS_FILE)).toContain('id: T001');
    const cards = events.filter((event) => event.type === 'artifact_written');
    expect(cards.map((event) => event.filename)).toEqual([PLAN_FILE, TASKS_FILE]);
  });

  it('outlines the tasks card by the briefs it was rendered from', () => {
    const { bus, events } = makeBusRecorder();

    writeAndPublishPlanArtifacts({
      projectDir: fixtureDir(),
      sessionId: SESSION_ID,
      bus,
      phase: 'planning',
      metadata: null,
      planMarkdown: '# Plan\n\nSteps.',
      tasks: TASKS,
    });

    expect(
      events.find((event) => event.type === 'artifact_written' && event.filename === TASKS_FILE),
    ).toMatchObject({
      excerpt: ['T001  Brief 1', 'T002  Brief 2', 'T003  Brief 3'],
      omittedCount: 0,
      omittedUnit: 'task',
    });
  });

  it('keeps a null metadata value write-only with no generated frontmatter', () => {
    const projectDir = fixtureDir();
    const { bus } = makeBusRecorder();

    writeAndPublishPlanArtifacts({
      projectDir,
      sessionId: SESSION_ID,
      bus,
      phase: 'planning',
      metadata: null,
      planMarkdown: '# Plan\n\nNo metadata.',
      tasks: TASKS,
    });

    expect(readSpecFile({ projectDir, sessionId: SESSION_ID }, PLAN_FILE)).toBe(
      '# Plan\n\nNo metadata.',
    );
  });
});
