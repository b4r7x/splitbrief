import type { Phase } from '../../../core/schemas/enums.js';
import { assertNever } from '../../../utils/type-guards.js';

// One vocabulary for what the run is doing right now: the byline says it as a heading, the build
// block says it inside a sentence. Both read it here.
export function activeVerb(phase: Phase, reviewerLabel: string | null): string {
  switch (phase) {
    case 'researching':
      return 'Researching…';
    case 'specifying':
      return 'Specifying…';
    case 'reviewing-spec':
      return 'Reviewing spec…';
    case 'clarifying':
      return 'Clarifying…';
    case 'constitution-check':
      return 'Checking constitution…';
    case 'planning':
      return 'Compiling briefs from spec…';
    case 'reviewing-plan':
      return 'Reviewing plan…';
    case 'reviewing-briefs':
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
  return activeVerb(phase, null).replace('…', '').toLowerCase();
}
