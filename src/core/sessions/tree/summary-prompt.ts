import type { TreeEntryEnvelope } from './schemas.js';
import type { BranchContext } from './branch-summary.js';

export function buildBranchSummaryPrompt(ctx: BranchContext): string {
  const entryDescriptions = ctx.entries
    .filter(e => e.type !== 'session-start')
    .map(e => `- [${e.type}] ${summarizePayload(e)}`)
    .join('\n');

  return `You are summarizing a failed execution branch for a task retry.

The branch attempted: ${ctx.taskTitle ?? 'unknown task'}
Recovery reason: ${ctx.recoveryReason}
Branch had ${ctx.entries.length} entries.

Entries (newest first):
${entryDescriptions}

Produce a JSON summary with exactly these fields:
{
  "goal": "What the branch was trying to accomplish (1 sentence)",
  "progress": ["What was completed successfully (bullet points)"],
  "decisions": ["Key decisions made during execution"],
  "constraints": ["Constraints discovered or confirmed"],
  "nextSteps": ["What should be tried differently"],
  "failureReason": "Why the branch failed (1 sentence)"
}

Be concise. Each array should have 1-5 items. Total response under 300 tokens.`;
}

function summarizePayload(entry: TreeEntryEnvelope): string {
  if (entry.payload === null || entry.payload === undefined) {
    return `(${entry.type} at ${new Date(entry.timestamp).toISOString()})`;
  }
  if (typeof entry.payload === 'object' && entry.payload !== null) {
    const obj = entry.payload as Record<string, unknown>;
    if ('message' in obj && typeof obj.message === 'string') {
      return obj.message.slice(0, 120);
    }
    if ('title' in obj && typeof obj.title === 'string') {
      return obj.title;
    }
  }
  return String(entry.payload).slice(0, 80);
}
