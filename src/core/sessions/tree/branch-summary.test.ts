import { describe, expect, it } from 'vitest';
import { entryId } from './schemas.js';
import { appendEntry, createEmptyTree } from './store.js';
import {
  mechanicalBranchSummary,
  parseBranchSummaryResponse,
  summarizeAndBranch,
} from './branch-summary.js';

const summaryJson = (goal: string) => JSON.stringify({
  goal,
  progress: ['Step 1'],
  decisions: ['Decision 1'],
  constraints: ['Constraint 1'],
  nextSteps: ['Try again'],
  failureReason: 'LLM failure',
  entryCount: 99,
  durationMs: 999,
});

describe('parseBranchSummaryResponse', () => {
  it('parses valid summaries from raw JSON, markdown JSON, and surrounding text', () => {
    expect(parseBranchSummaryResponse(summaryJson('Raw'))?.goal).toBe('Raw');
    expect(parseBranchSummaryResponse(`Some text\n\`\`\`json\n${summaryJson('Markdown')}\n\`\`\`\nDone`)?.goal).toBe('Markdown');
    expect(parseBranchSummaryResponse(`First {"a":1} then ${summaryJson('Inline')} finally {"b":2}`)?.goal).toBe('Inline');
  });

  it('returns null for invalid or incomplete summaries', () => {
    expect(parseBranchSummaryResponse('not json at all')).toBeNull();
    expect(parseBranchSummaryResponse('{"goal":"Test","progress":[]}')).toBeNull();
    expect(parseBranchSummaryResponse('{"goal":"Test","progress":[],"decisions":[],"constraints":[],"nextSteps":[],"failureReason":"Error","entryCount":-1,"durationMs":100}')).toBeNull();
  });

  it('prefers markdown code blocks over inline JSON', () => {
    const raw = `Inline ${summaryJson('Wrong')}\n\`\`\`json\n${summaryJson('Right')}\n\`\`\``;

    expect(parseBranchSummaryResponse(raw)?.goal).toBe('Right');
  });
});

describe('mechanicalBranchSummary', () => {
  it('summarizes the failed path when no LLM summary is available', () => {
    const entries = [
      { id: entryId('E0004'), parentId: entryId('E0003'), type: 'message', timestamp: 4000, payload: null },
      { id: entryId('E0003'), parentId: entryId('E0002'), type: 'message', timestamp: 3000, payload: null },
      { id: entryId('E0002'), parentId: entryId('E0001'), type: 'action', timestamp: 2000, payload: null },
      { id: entryId('E0001'), parentId: null, type: 'start', timestamp: 1000, payload: null },
    ];

    const summary = mechanicalBranchSummary({
      entries,
      recoveryReason: 'Test failure',
      taskTitle: 'My Task',
    });

    expect(summary).toMatchObject({
      goal: 'My Task',
      failureReason: 'Test failure',
      entryCount: 4,
      durationMs: 3000,
      decisions: [],
      constraints: [],
    });
    expect(summary.progress).toEqual(['2x message', '1x action', '1x start']);
    expect(summary.nextSteps[0]).toContain('Test failure');
  });

  it('falls back cleanly for empty or single-entry paths', () => {
    expect(mechanicalBranchSummary({ entries: [], recoveryReason: 'Error' })).toMatchObject({
      goal: 'Unknown task execution',
      entryCount: 0,
      durationMs: 0,
    });
    expect(mechanicalBranchSummary({
      entries: [{ id: entryId('E0001'), parentId: null, type: 'start', timestamp: 1000, payload: null }],
      recoveryReason: 'Error',
    }).durationMs).toBe(0);
  });
});

describe('summarizeAndBranch', () => {
  it('uses a valid LLM summary, then anchors counts and duration to the failed path', async () => {
    let tree = createEmptyTree(1000);
    const first = appendEntry(tree, { type: 'message', payload: {}, timestamp: 2000 });
    tree = first.tree;
    const second = appendEntry(tree, { type: 'action', payload: {}, timestamp: 3000 });
    tree = second.tree;

    const result = await summarizeAndBranch({
      tree,
      failedLeafId: second.entry.id,
      branchPointId: first.entry.id,
      recoveryReason: 'Test error',
      timestamp: 4000,
      callLlm: async () => summaryJson('LLM goal'),
    });

    expect(result.summary).toMatchObject({
      goal: 'LLM goal',
      failureReason: 'LLM failure',
      entryCount: 3,
      durationMs: 2000,
    });
    expect(result.entry).toMatchObject({
      type: 'branch-summary',
      parentId: first.entry.id,
      display: true,
      payload: result.summary,
    });
    expect(result.tree.children.get(first.entry.id)).toContain(result.entry.id);
    expect(tree.meta.entryCount).toBe(3);
  });

  it.each([
    { name: 'without an LLM', callLlm: null },
    { name: 'when the LLM returns invalid JSON', callLlm: async () => 'not valid json' },
    {
      name: 'when the LLM throws',
      callLlm: async () => {
        throw new Error('LLM failed');
      },
    },
  ])('creates a mechanical branch summary $name', async ({ callLlm }) => {
    let tree = createEmptyTree(1000);
    const entry = appendEntry(tree, { type: 'message', payload: {}, timestamp: 2000 });
    tree = entry.tree;

    const result = await summarizeAndBranch({
      tree,
      failedLeafId: entry.entry.id,
      branchPointId: entryId('E0001'),
      recoveryReason: 'Test error',
      taskTitle: 'My Special Task',
      timestamp: 3000,
      callLlm,
    });

    expect(result.summary).toMatchObject({
      goal: 'My Special Task',
      failureReason: 'Test error',
      entryCount: 2,
      durationMs: 1000,
    });
    expect(result.entry.type).toBe('branch-summary');
    expect(result.tree.meta.branchCount).toBe(1);
  });
});
