import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../core/state/machine.js';
import { loadState } from '../../core/state/persistence.js';
import { ensureSessionDir, readSpecFile } from '../../core/paths-io.js';
import { REVIEW_FILE } from '../../core/paths.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeBusRecorder,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { runReviewerCall } from './review-call.js';

let dirs: string[] = [];

function setupProjectDir(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('review-call');
  dirs.push(projectDir);
  const sessionId = 'sess-review-call';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('runReviewerCall', () => {
  it('writes review.md and attributes the usage to the reviewer bucket', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus } = makeBusRecorder();
    const reviewer = makePlanner({
      review: vi.fn().mockResolvedValue({
        text: '# Review\n\nLooks good.\n',
        usage: { inputTokens: 41, outputTokens: 17 },
      }),
    });

    const result = await runReviewerCall({
      reviewer,
      prompt: 'review the diff',
      projectDir,
      sessionId,
      bus,
      state: createInitialState('feature'),
      metadata: TEST_METADATA,
    });

    expect(result.text).toBe('# Review\n\nLooks good.\n');
    expect(readSpecFile({ projectDir, sessionId }, REVIEW_FILE)).toContain('Looks good.');
    expect(result.state.tokenUsage).toMatchObject({
      reviewerInput: 41,
      reviewerOutput: 17,
      plannerInput: 0,
      plannerOutput: 0,
    });
    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.tokenUsage).toMatchObject({ reviewerInput: 41, reviewerOutput: 17 });
  });

  it('streams the review body to the bus instead of publishing an artifact card', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    const reviewer = makePlanner({
      review: vi.fn().mockImplementation(async (_prompt, _dir, callbacks) => {
        callbacks.onOutput?.('partial review text');
        return { text: 'partial review text', usage: null };
      }),
    });

    await runReviewerCall({
      reviewer,
      prompt: 'review the diff',
      projectDir,
      sessionId,
      bus,
      state: createInitialState('feature'),
    });

    expect(
      events.filter(
        (event) => event.type === 'planner_text' && event.text === 'partial review text',
      ),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
  });
});
