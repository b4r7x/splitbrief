import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import type { StepRef } from '../schemas/run-step.js';
import type { EventTypeCarrier } from '../event-phase.js';
import type { RecoveryPromptedEvent, RecoveryResolvedEvent } from './events.js';

/** The halt the run waits on, and the step it resumes at once the halt is answered. */
export interface RunHalt {
  readonly issue: RecoveryIssue;
  readonly at: StepRef;
}

function isRecoveryPrompted<T extends EventTypeCarrier>(
  event: T,
): event is T & RecoveryPromptedEvent {
  return event.type === 'recovery_prompted';
}

function isRecoveryResolved<T extends EventTypeCarrier>(
  event: T,
): event is T & RecoveryResolvedEvent {
  return event.type === 'recovery_resolved';
}

/**
 * A prompt written before the log carried its issue changes nothing; the settle step names the
 * halt of a run read back from disk.
 */
export function reduceHalt(halt: RunHalt | null, event: EventTypeCarrier): RunHalt | null {
  if (isRecoveryPrompted(event)) {
    if (event.issue === undefined || event.at === undefined) return halt;
    return { issue: event.issue, at: event.at };
  }
  if (isRecoveryResolved(event)) return halt?.issue.id === event.issueId ? null : halt;
  // A run that ends or starts again waits on no halt.
  if (
    event.type === 'workflow_cancelled' ||
    event.type === 'workflow_complete' ||
    event.type === 'workflow_started'
  ) {
    return null;
  }
  return halt;
}
