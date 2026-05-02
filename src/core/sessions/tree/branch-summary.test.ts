import { describe, it, expect } from 'vitest';
import {
  BranchSummarySchema,
  parseBranchSummaryResponse,
  mechanicalBranchSummary,
  summarizeAndBranch,
} from './branch-summary.js';
import { createEmptyTree, appendEntry } from './store.js';
import { entryId } from './schemas.js';

describe('BranchSummarySchema', () => {
  it('accepts a valid branch summary', () => {
    const summary = {
      goal: 'Implement feature X',
      progress: ['Set up project', 'Wrote tests'],
      decisions: ['Used Zod for validation'],
      constraints: ['Must support ESM only'],
      nextSteps: ['Implement the UI'],
      failureReason: 'Ran out of time',
      entryCount: 5,
      durationMs: 10000,
    };
    expect(BranchSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('rejects negative entryCount', () => {
    const summary = {
      goal: 'Test',
      progress: [],
      decisions: [],
      constraints: [],
      nextSteps: [],
      failureReason: 'Error',
      entryCount: -1,
      durationMs: 0,
    };
    expect(BranchSummarySchema.safeParse(summary).success).toBe(false);
  });

  it('rejects negative durationMs', () => {
    const summary = {
      goal: 'Test',
      progress: [],
      decisions: [],
      constraints: [],
      nextSteps: [],
      failureReason: 'Error',
      entryCount: 0,
      durationMs: -1,
    };
    expect(BranchSummarySchema.safeParse(summary).success).toBe(false);
  });

  it('rejects non-integer entryCount', () => {
    const summary = {
      goal: 'Test',
      progress: [],
      decisions: [],
      constraints: [],
      nextSteps: [],
      failureReason: 'Error',
      entryCount: 1.5,
      durationMs: 0,
    };
    expect(BranchSummarySchema.safeParse(summary).success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const summary = {
      goal: 'Test',
      progress: [],
      decisions: [],
      constraints: [],
      nextSteps: [],
      failureReason: 'Error',
    };
    expect(BranchSummarySchema.safeParse(summary).success).toBe(false);
  });
});

describe('parseBranchSummaryResponse', () => {
  it('extracts and parses valid JSON from markdown', () => {
    const raw = 'Some text before\n```json\n{"goal":"Test","progress":[],"decisions":[],"constraints":[],"nextSteps":[],"failureReason":"Error","entryCount":1,"durationMs":100}\n```\nSome text after';
    const result = parseBranchSummaryResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.goal).toBe('Test');
  });

  it('parses raw JSON string', () => {
    const raw = '{"goal":"Test","progress":[],"decisions":[],"constraints":[],"nextSteps":[],"failureReason":"Error","entryCount":1,"durationMs":100}';
    const result = parseBranchSummaryResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.goal).toBe('Test');
  });

  it('returns null for invalid JSON', () => {
    const raw = 'not json at all';
    expect(parseBranchSummaryResponse(raw)).toBeNull();
  });

  it('returns null for JSON that does not match schema', () => {
    const raw = '{"goal":"Test","progress":[],"decisions":[],"constraints":[],"nextSteps":[],"failureReason":"Error","entryCount":-1,"durationMs":100}';
    expect(parseBranchSummaryResponse(raw)).toBeNull();
  });

  it('returns null for partial JSON missing required fields', () => {
    const raw = '{"goal":"Test","progress":[]}';
    expect(parseBranchSummaryResponse(raw)).toBeNull();
  });

  it('handles nested braces correctly', () => {
    const raw = 'start {"goal":"Test","progress":["a","b"],"decisions":[],"constraints":[],"nextSteps":[],"failureReason":"Error","entryCount":1,"durationMs":100} end';
    const result = parseBranchSummaryResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.progress).toEqual(['a', 'b']);
  });

  it('parses JSON from markdown code block', () => {
    const raw = 'Here is the summary:\n```json\n{"goal":"Test","progress":[],"decisions":[],"constraints":[],"nextSteps":[],"failureReason":"Error","entryCount":1,"durationMs":100}\n```\nDone.';
    const result = parseBranchSummaryResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.goal).toBe('Test');
  });

  it('does not over-capture when multiple JSON objects exist', () => {
    const raw = 'First {"a":1} then {"goal":"Test","progress":[],"decisions":[],"constraints":[],"nextSteps":[],"failureReason":"Error","entryCount":1,"durationMs":100} finally {"b":2}';
    const result = parseBranchSummaryResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.goal).toBe('Test');
  });

  it('prefers markdown code block over inline JSON', () => {
    const raw = 'Inline {"goal":"Wrong","progress":[],"decisions":[],"constraints":[],"nextSteps":[],"failureReason":"Error","entryCount":1,"durationMs":100}\n```json\n{"goal":"Right","progress":[],"decisions":[],"constraints":[],"nextSteps":[],"failureReason":"Error","entryCount":1,"durationMs":100}\n```';
    const result = parseBranchSummaryResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.goal).toBe('Right');
  });
});

describe('mechanicalBranchSummary', () => {
  it('generates summary with task title', () => {
    const ctx = {
      entries: [],
      recoveryReason: 'Test failure',
      taskTitle: 'My Task',
    };
    const result = mechanicalBranchSummary(ctx);
    expect(result.goal).toBe('My Task');
    expect(result.failureReason).toBe('Test failure');
    expect(result.nextSteps[0]).toContain('Test failure');
  });

  it('falls back to unknown task when no title', () => {
    const ctx = {
      entries: [],
      recoveryReason: 'Error',
    };
    const result = mechanicalBranchSummary(ctx);
    expect(result.goal).toBe('Unknown task execution');
  });

  it('calculates duration from first to last entry', () => {
    const entries = [
      { id: entryId('E0003'), parentId: entryId('E0002'), type: 'end', timestamp: 3000, payload: null },
      { id: entryId('E0002'), parentId: entryId('E0001'), type: 'middle', timestamp: 2000, payload: null },
      { id: entryId('E0001'), parentId: null, type: 'start', timestamp: 1000, payload: null },
    ];
    const ctx = {
      entries,
      recoveryReason: 'Error',
    };
    const result = mechanicalBranchSummary(ctx);
    expect(result.durationMs).toBe(2000);
  });

  it('returns zero duration for single entry', () => {
    const entries = [
      { id: entryId('E0001'), parentId: null, type: 'start', timestamp: 1000, payload: null },
    ];
    const ctx = {
      entries,
      recoveryReason: 'Error',
    };
    const result = mechanicalBranchSummary(ctx);
    expect(result.durationMs).toBe(0);
  });

  it('returns zero duration for empty entries', () => {
    const ctx = {
      entries: [],
      recoveryReason: 'Error',
    };
    const result = mechanicalBranchSummary(ctx);
    expect(result.durationMs).toBe(0);
  });

  it('builds type breakdown progress', () => {
    const entries = [
      { id: entryId('E0003'), parentId: entryId('E0002'), type: 'message', timestamp: 3000, payload: null },
      { id: entryId('E0002'), parentId: entryId('E0001'), type: 'message', timestamp: 2000, payload: null },
      { id: entryId('E0001'), parentId: null, type: 'action', timestamp: 1000, payload: null },
    ];
    const ctx = {
      entries,
      recoveryReason: 'Error',
    };
    const result = mechanicalBranchSummary(ctx);
    expect(result.progress).toContain('2x message');
    expect(result.progress).toContain('1x action');
  });

  it('limits progress to 5 items', () => {
    const entries = [
      { id: entryId('E0006'), parentId: entryId('E0005'), type: 'type6', timestamp: 6000, payload: null },
      { id: entryId('E0005'), parentId: entryId('E0004'), type: 'type5', timestamp: 5000, payload: null },
      { id: entryId('E0004'), parentId: entryId('E0003'), type: 'type4', timestamp: 4000, payload: null },
      { id: entryId('E0003'), parentId: entryId('E0002'), type: 'type3', timestamp: 3000, payload: null },
      { id: entryId('E0002'), parentId: entryId('E0001'), type: 'type2', timestamp: 2000, payload: null },
      { id: entryId('E0001'), parentId: null, type: 'type1', timestamp: 1000, payload: null },
    ];
    const ctx = {
      entries,
      recoveryReason: 'Error',
    };
    const result = mechanicalBranchSummary(ctx);
    expect(result.progress.length).toBe(5);
  });

  it('sets entryCount to number of entries', () => {
    const entries = [
      { id: entryId('E0002'), parentId: entryId('E0001'), type: 'a', timestamp: 2000, payload: null },
      { id: entryId('E0001'), parentId: null, type: 'b', timestamp: 1000, payload: null },
    ];
    const ctx = {
      entries,
      recoveryReason: 'Error',
    };
    const result = mechanicalBranchSummary(ctx);
    expect(result.entryCount).toBe(2);
  });

  it('returns empty arrays for decisions and constraints', () => {
    const ctx = {
      entries: [],
      recoveryReason: 'Error',
    };
    const result = mechanicalBranchSummary(ctx);
    expect(result.decisions).toEqual([]);
    expect(result.constraints).toEqual([]);
  });
});

describe('summarizeAndBranch', () => {
  it('creates mechanical summary when callLlm is null', async () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'message', payload: {}, timestamp: 2000 });
    tree = r1.tree;

    const result = await summarizeAndBranch({
      tree,
      failedLeafId: r1.entry.id,
      branchPointId: entryId('E0001'),
      recoveryReason: 'Test error',
      timestamp: 3000,
      callLlm: null,
    });

    expect(result.summary.goal).toBe('Unknown task execution');
    expect(result.summary.failureReason).toBe('Test error');
    expect(result.entry.type).toBe('branch-summary');
    expect(result.tree.meta.branchCount).toBe(1);
  });

  it('uses LLM summary when provided valid JSON', async () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'message', payload: {}, timestamp: 2000 });
    tree = r1.tree;

    const llmResponse = JSON.stringify({
      goal: 'LLM goal',
      progress: ['Step 1'],
      decisions: ['Decision 1'],
      constraints: ['Constraint 1'],
      nextSteps: ['Try again'],
      failureReason: 'LLM failure',
      entryCount: 99,
      durationMs: 999,
    });

    const result = await summarizeAndBranch({
      tree,
      failedLeafId: r1.entry.id,
      branchPointId: entryId('E0001'),
      recoveryReason: 'Test error',
      timestamp: 3000,
      callLlm: async () => llmResponse,
    });

    expect(result.summary.goal).toBe('LLM goal');
    expect(result.summary.failureReason).toBe('LLM failure');
    expect(result.entry.type).toBe('branch-summary');
  });

  it('falls back to mechanical summary when LLM returns invalid JSON', async () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'message', payload: {}, timestamp: 2000 });
    tree = r1.tree;

    const result = await summarizeAndBranch({
      tree,
      failedLeafId: r1.entry.id,
      branchPointId: entryId('E0001'),
      recoveryReason: 'Test error',
      timestamp: 3000,
      callLlm: async () => 'not valid json',
    });

    expect(result.summary.goal).toBe('Unknown task execution');
    expect(result.summary.failureReason).toBe('Test error');
    expect(result.entry.type).toBe('branch-summary');
  });

  it('falls back to mechanical summary when LLM throws', async () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'message', payload: {}, timestamp: 2000 });
    tree = r1.tree;

    const result = await summarizeAndBranch({
      tree,
      failedLeafId: r1.entry.id,
      branchPointId: entryId('E0001'),
      recoveryReason: 'Test error',
      timestamp: 3000,
      callLlm: async () => {
        throw new Error('LLM failed');
      },
    });

    expect(result.summary.goal).toBe('Unknown task execution');
    expect(result.summary.failureReason).toBe('Test error');
    expect(result.entry.type).toBe('branch-summary');
  });

  it('overrides entryCount and durationMs from actual path', async () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'message', payload: {}, timestamp: 2000 });
    tree = r1.tree;
    const r2 = appendEntry(tree, { type: 'action', payload: {}, timestamp: 3000 });
    tree = r2.tree;

    const llmResponse = JSON.stringify({
      goal: 'LLM goal',
      progress: [],
      decisions: [],
      constraints: [],
      nextSteps: [],
      failureReason: 'LLM failure',
      entryCount: 99,
      durationMs: 999,
    });

    const result = await summarizeAndBranch({
      tree,
      failedLeafId: r2.entry.id,
      branchPointId: entryId('E0001'),
      recoveryReason: 'Test error',
      timestamp: 4000,
      callLlm: async () => llmResponse,
    });

    expect(result.summary.entryCount).toBe(3);
    expect(result.summary.durationMs).toBe(2000);
  });

  it('creates branch from specified branchPointId', async () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'message', payload: {}, timestamp: 2000 });
    tree = r1.tree;
    const r2 = appendEntry(tree, { type: 'action', payload: {}, timestamp: 3000 });
    tree = r2.tree;

    const result = await summarizeAndBranch({
      tree,
      failedLeafId: r2.entry.id,
      branchPointId: r1.entry.id,
      recoveryReason: 'Test error',
      timestamp: 4000,
      callLlm: null,
    });

    expect(result.entry.parentId).toBe(r1.entry.id);
    expect(result.tree.children.get(r1.entry.id)).toContain(result.entry.id);
  });

  it('sets display to true on branch summary entry', async () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'message', payload: {}, timestamp: 2000 });
    tree = r1.tree;

    const result = await summarizeAndBranch({
      tree,
      failedLeafId: r1.entry.id,
      branchPointId: entryId('E0001'),
      recoveryReason: 'Test error',
      timestamp: 3000,
      callLlm: null,
    });

    expect(result.entry.display).toBe(true);
  });

  it('includes taskTitle in summary when provided', async () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'message', payload: {}, timestamp: 2000 });
    tree = r1.tree;

    const result = await summarizeAndBranch({
      tree,
      failedLeafId: r1.entry.id,
      branchPointId: entryId('E0001'),
      recoveryReason: 'Test error',
      taskTitle: 'My Special Task',
      timestamp: 3000,
      callLlm: null,
    });

    expect(result.summary.goal).toBe('My Special Task');
  });

  it('sets durationMs to zero for single-entry path', async () => {
    const tree = createEmptyTree(1000);

    const result = await summarizeAndBranch({
      tree,
      failedLeafId: entryId('E0001'),
      branchPointId: entryId('E0001'),
      recoveryReason: 'Test error',
      timestamp: 3000,
      callLlm: null,
    });

    expect(result.summary.durationMs).toBe(0);
  });

  it('does not mutate original tree', async () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'message', payload: {}, timestamp: 2000 });
    tree = r1.tree;
    const originalEntryCount = tree.meta.entryCount;

    await summarizeAndBranch({
      tree,
      failedLeafId: r1.entry.id,
      branchPointId: entryId('E0001'),
      recoveryReason: 'Test error',
      timestamp: 3000,
      callLlm: null,
    });

    expect(tree.meta.entryCount).toBe(originalEntryCount);
  });
});
