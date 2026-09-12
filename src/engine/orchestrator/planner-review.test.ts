import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState } from '../../core/state/machine.js';
import { loadState } from '../../core/state/persistence.js';
import { ensureSessionDir, readSpecFile, writeSpecFile } from '../../core/paths-io.js';
import { SPEC_FILE, TASKS_FILE, sessionDir } from '../../core/paths.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeBusRecorder,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { runPlannerReview } from './planner-review.js';

let dirs: string[] = [];

function setupProjectDir(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('planner-review-candidate');
  dirs.push(projectDir);
  const sessionId = 'sess-review-candidate';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('runPlannerReview candidate mode', () => {
  it('returns the review text as a non-canonical candidate without touching tasks.md', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    const priorBriefs = '# Prior Task Briefs\n\nUnchanged.\n';
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, priorBriefs, TEST_METADATA);
    const priorBytes = readSpecFile({ projectDir, sessionId }, TASKS_FILE);
    const planner = makePlanner({
      review: vi.fn().mockResolvedValue({
        text: '# Regenerated Task Briefs\n\nCandidate only.\n',
        usage: { inputTokens: 23, outputTokens: 11 },
      }),
    });

    const result = await runPlannerReview({
      planner,
      prompt: 'regenerate the briefs',
      projectDir,
      sessionId,
      bus,
      state: createInitialState('feature'),
      metadata: TEST_METADATA,
      returnCandidate: true,
    });

    expect(result.text).toBe('# Regenerated Task Briefs\n\nCandidate only.\n');
    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toBe(priorBytes);
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
    const persisted = loadState({ projectDir, sessionId });
    expect(persisted).not.toBeNull();
    if (persisted === null) throw new Error('expected usage state to be persisted');
    expect(persisted.tokenUsage).toMatchObject({ plannerInput: 23, plannerOutput: 11 });
  });

  it('never creates tasks.md when no prior briefs exist', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus } = makeBusRecorder();
    const planner = makePlanner({
      review: vi.fn().mockResolvedValue({ text: 'candidate briefs', usage: null }),
    });

    await runPlannerReview({
      planner,
      prompt: 'regenerate the briefs',
      projectDir,
      sessionId,
      bus,
      state: createInitialState('feature'),
      returnCandidate: true,
    });

    expect(existsSync(join(sessionDir(projectDir, sessionId), TASKS_FILE))).toBe(false);
  });

  it('still writes a spec when candidate mode is not requested', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      review: vi.fn().mockResolvedValue({ text: '# Spec\n\nWritten.\n', usage: null }),
    });

    await runPlannerReview({
      planner,
      prompt: 'write the spec',
      projectDir,
      sessionId,
      bus,
      state: createInitialState('feature'),
      metadata: TEST_METADATA,
      writeTo: SPEC_FILE,
    });

    expect(readSpecFile({ projectDir, sessionId }, SPEC_FILE)).toContain('# Spec\n\nWritten.\n');
    expect(
      events.filter((event) => event.type === 'artifact_written' && event.filename === SPEC_FILE),
    ).toHaveLength(1);
  });
});
