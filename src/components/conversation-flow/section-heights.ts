import type { TuiEvent } from '../../types.js';
import type { Section } from '../../core/event-sections.js';
import { assertNever } from '../../utils/type-guards.js';

const GUTTER_PADDING = 14;

export function visualLineCount(text: string, width: number): number {
  const effective = Math.max(20, width - GUTTER_PADDING);
  let lines = 0;
  const rawLines = text.split('\n');
  for (const raw of rawLines) {
    const len = raw.length;
    lines += len === 0 ? 1 : Math.ceil(len / effective);
  }
  return lines;
}

function estimateEventHeight(event: TuiEvent, diffExpanded?: boolean, cols?: number): number {
  const w = cols ?? 80;
  switch (event.type) {
    case 'planner-status':
      return 0; // rendered in L1 chrome, not scroll region
    case 'planner-text':
      return Math.max(1, visualLineCount(event.text, w));
    case 'task-start':
      return 4;
    case 'task-complete':
    case 'task-skipped':
      return 1;
    case 'implementer-generate-running':
      return 3;
    case 'implementer-generate-done':
      return diffExpanded ? 6 : 4;
    case 'implementer-generate-failed':
      return 3;
    case 'validate':
      if (event.status === 'running') return 3;
      return event.error ? 5 : 4;
    case 'retry':
      return 3;
    case 'escalate':
      return event.hint ? 4 : 3;
    case 'git-commit':
    case 'git-checkpoint':
      return 3;
    case 'warning':
    case 'error':
      return 3;
    case 'cost-update':
      return 1;
    case 'cost-prediction':
      return 5;
    case 'budget-warning':
    case 'budget-exceeded':
      return 3;
    case 'workflow-cancelled':
      return 3;
    case 'workflow-config':
      return 0; // rendered in L2 chrome, not scroll region
    case 'rewind':
    case 'task-reset':
    case 'message-queued':
    case 'message-injected-native':
    case 'queue-drained':
    case 'queue-cleared':
      return 3;
    case 'user-message':
      return Math.max(1, visualLineCount(event.text, w));
    default:
      return assertNever(event);
  }
}

/** Events rendered in chrome (L1/L2), not in the scroll region — no spacer Box */
const SPACER_EXCLUDED = new Set<TuiEvent['type']>(['planner-status', 'workflow-config']);

export function estimateSectionHeight(section: Section, expandedDiffs: Set<number>, cols?: number): number {
  if (section.type === 'completed-task') return 1;
  let total = 0;
  let spacerCount = 0;
  for (const [i, ev] of section.items.entries()) {
    const h = estimateEventHeight(ev, expandedDiffs.has(section.startIndex + i), cols);
    const spacer = SPACER_EXCLUDED.has(ev.type) ? 0 : 1;
    total += h + spacer;
    if (spacer) spacerCount++;
  }
  // Convert from N trailers to N-1 separators (no spacer after last event)
  return total - (spacerCount > 0 ? 1 : 0);
}

export function findLatestDiffEventIndex(events: TuiEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (ev.type === 'implementer-generate-done' && ev.diff) {
      return i;
    }
  }
  return null;
}
