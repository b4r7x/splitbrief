import type { Phase } from '../../../core/schemas/enums.js';
import type { PlannerCall } from '../../../core/schemas/run-step.js';
import { SOFT_SEP } from '../../../core/separators.js';
import type { RunningSuiteStage } from '../../../stores/workflow/operations/state.js';
import { assertNever } from '../../../utils/type-guards.js';

// One vocabulary for what the run is doing right now: the byline says it as a heading, the build
// block says it inside a sentence. Both read it here. The plan stage is one planning session, and
// only an older run's briefs call has a verb of its own. A gate that rewrites its document from a
// change request names that call with the verb it has outside the gate.
export function activeVerb(
  phase: Phase,
  reviewerLabel: string | null,
  plannerCall: PlannerCall | null,
): string {
  switch (phase) {
    case 'researching':
      return 'Researching…';
    case 'specifying':
      return 'Specifying…';
    case 'reviewing-spec':
      if (plannerCall !== null) return activeVerb('specifying', reviewerLabel, plannerCall);
      return 'Reviewing spec…';
    case 'clarifying':
      return 'Clarifying…';
    case 'constitution-check':
      return 'Checking constitution…';
    case 'planning':
      if (plannerCall === 'tasks') return 'Compiling briefs…';
      return 'Planning…';
    case 'reviewing-plan':
      if (plannerCall !== null) return activeVerb('planning', reviewerLabel, plannerCall);
      return 'Reviewing plan…';
    case 'reviewing-briefs':
      if (plannerCall !== null) return activeVerb('planning', reviewerLabel, plannerCall);
      return 'Reviewing briefs…';
    case 'analyzing':
      return 'Analyzing…';
    case 'implementing':
      return 'Implementing…';
    case 'validating-task':
      return 'Validating…';
    case 'escalating':
      return 'Escalating…';
    case 'final-review':
      return reviewerLabel === null ? 'Review…' : `Review… ${reviewerLabel}`;
    case 'idle':
    case 'complete':
      return '';
    default:
      return assertNever(phase);
  }
}

/** The same verb inside a sentence: no capital, no ellipsis, no reviewer name. */
export function inlineActiveVerb(phase: Phase): string {
  return activeVerb(phase, null, null).replace('…', '').toLowerCase();
}

/** The full suite a run-start, batch-boundary or pre-review stage runs, and its command. */
export function suiteStageText(suite: Pick<RunningSuiteStage, 'moment' | 'command'>): string {
  return `${suiteMomentLabel(suite.moment)}${SOFT_SEP}${suite.command}`;
}

function suiteMomentLabel(moment: RunningSuiteStage['moment']): string {
  switch (moment) {
    case 'baseline':
      return 'Run-start suite';
    case 'boundary':
      return 'Batch suite';
    case 'pre-review':
      return 'Pre-review suite';
    default:
      return assertNever(moment);
  }
}
