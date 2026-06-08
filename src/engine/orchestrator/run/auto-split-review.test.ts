import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { formatTasks } from '../../spec/formatter.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { reviewAutoSplitOutput } from './auto-split-review.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function makePassingTask(overrides?: Parameters<typeof makeTask>[0]) {
  return makeTask({
    implementationSteps: ['Implement the parser branch'],
    tests: ['parser handles the accepted branch'],
    scope: { inBounds: ['src/parser.ts'] },
    evidence: ['Parser-focused test passes'],
    ...overrides,
  });
}

const malformedTaskLikeBlock = `---
id: T002
title:
action: invalid
file:
depends_on: []
---

### Description
This block looks like a task but has invalid frontmatter.
`;

describe('reviewAutoSplitOutput', () => {
  it('rejects an approved tasks.md that mixes valid tasks with malformed task-like blocks', async () => {
    const projectDir = createTempDir('auto-split-review-test');
    dirs.push(projectDir);
    const sessionId = 'sess-auto-split';
    const task = makePassingTask({ id: 'T001', file: 'src/parser.ts' });
    const state = makeImplState([task]);
    const { bus, events } = makeBusRecorder();
    const onApprovalNeeded = vi.fn(async (_type: 'spec' | 'plan' | 'briefs', filePath: string) => {
      await writeFile(filePath, `${formatTasks([task])}\n${malformedTaskLikeBlock}`, 'utf8');
      return { approved: true };
    });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const setTrackedState = vi.fn();

    const result = await reviewAutoSplitOutput({
      wctx: makeWctx({ projectDir, sessionId, bus, callbacks }),
      state,
      tasks: [task],
      setTrackedState,
    });

    expect(result).toMatchObject({ approved: false, tasks: [task] });
    expect(onApprovalNeeded).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('invalid Task Briefs'),
      }),
    );
  });
});
