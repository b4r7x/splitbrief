import type { TreeEntryEnvelope, EntryId } from './schemas.js';
import type { SessionTree } from './store.js';
import { pathToRoot, branchFrom } from './store.js';
import { buildBranchSummaryPrompt } from './summary-prompt.js';
import { BranchSummaryPayloadSchema } from './entry-types.js';
import type { BranchSummaryPayload } from './entry-types.js';
import type { BranchContext } from './branch-context.js';

export type BranchSummary = BranchSummaryPayload;

export function parseBranchSummaryResponse(raw: string): BranchSummary | null {
  // Try to extract JSON from markdown code blocks first
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      const parsed: unknown = JSON.parse((codeBlockMatch[1] ?? '').trim());
      const result = BranchSummaryPayloadSchema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // Fall through to brace matching
    }
  }

  // Find all {…} blocks and try each one
  const matches = raw.matchAll(/\{[\s\S]*?\}/g);
  for (const match of matches) {
    try {
      const parsed: unknown = JSON.parse(match[0]);
      const result = BranchSummaryPayloadSchema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
    }
  }

  return null;
}

export function mechanicalBranchSummary(ctx: BranchContext): BranchSummary {
  const firstEntry = ctx.entries[ctx.entries.length - 1];
  const lastEntry = ctx.entries[0];
  const durationMs = lastEntry && firstEntry
    ? lastEntry.timestamp - firstEntry.timestamp
    : 0;

  const typeBreakdown = new Map<string, number>();
  for (const entry of ctx.entries) {
    typeBreakdown.set(entry.type, (typeBreakdown.get(entry.type) ?? 0) + 1);
  }

  const progress = [...typeBreakdown.entries()]
    .map(([type, count]) => `${count}x ${type}`)
    .slice(0, 5);

  return {
    goal: ctx.taskTitle ?? 'Unknown task execution',
    progress,
    decisions: [],
    constraints: [],
    nextSteps: [`Retry with different approach (previous attempt: ${ctx.recoveryReason})`],
    failureReason: ctx.recoveryReason,
    entryCount: ctx.entries.length,
    durationMs,
  };
}

interface SummarizeBranchOptions {
  tree: SessionTree;
  failedLeafId: EntryId;
  branchPointId: EntryId;
  recoveryReason: string;
  taskTitle?: string;
  timestamp: number;
  callLlm: ((prompt: string) => Promise<string>) | null;
}

export async function summarizeAndBranch(opts: SummarizeBranchOptions): Promise<{
  tree: SessionTree;
  summary: BranchSummary;
  entry: TreeEntryEnvelope;
}> {
  const failedPath = pathToRoot(opts.tree, opts.failedLeafId);

  const ctx: BranchContext = {
    entries: failedPath,
    recoveryReason: opts.recoveryReason,
    taskTitle: opts.taskTitle,
  };

  let summary: BranchSummary;

  if (opts.callLlm) {
    const prompt = buildBranchSummaryPrompt(ctx);
    try {
      const response = await opts.callLlm(prompt);
      const parsed = parseBranchSummaryResponse(response);
      summary = parsed ?? mechanicalBranchSummary(ctx);
    } catch {
      summary = mechanicalBranchSummary(ctx);
    }
  } else {
    summary = mechanicalBranchSummary(ctx);
  }

  summary = {
    ...summary,
    entryCount: failedPath.length,
    durationMs: failedPath.length > 1
      ? (failedPath[0]?.timestamp ?? 0) - (failedPath[failedPath.length - 1]?.timestamp ?? 0)
      : 0,
  };

  const { tree: newTree, entry } = branchFrom(opts.tree, {
    fromId: opts.branchPointId,
    type: 'branch-summary',
    payload: summary,
    timestamp: opts.timestamp,
    display: true,
  });

  return { tree: newTree, summary, entry };
}
