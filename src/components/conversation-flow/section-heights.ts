import type { TuiEvent } from '../../types.js';
import type { Section } from '../../core/event-sections.js';
import { assertNever } from '../../utils/type-guards.js';

function estimateEventHeight(event: TuiEvent, diffExpanded?: boolean): number {
  switch (event.type) {
    case 'planner-status':
      return 3;
    case 'planner-text':
      return Math.max(3, event.text.split('\n').length + 2);
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
      return 3;
    case 'rewind':
    case 'task-reset':
    case 'message-queued':
    case 'message-injected-native':
    case 'queue-drained':
    case 'queue-cleared':
      return 3;
    default:
      return assertNever(event);
  }
}

export function estimateSectionHeight(section: Section, expandedDiffs: Set<number>): number {
  if (section.type === 'completed-task') return 1;
  return section.items.reduce(
    (sum, ev, i) => sum + estimateEventHeight(ev, expandedDiffs.has(section.startIndex + i)),
    0,
  );
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
