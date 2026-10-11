import { assertNever } from '../../utils/type-guards.js';

export type StateMeaning = 'passed' | 'failed' | 'attention' | 'running' | 'pending';
export type StateTone = 'success' | 'error' | 'warning' | 'accent' | 'textDim';

export function stateTone(state: StateMeaning): StateTone {
  switch (state) {
    case 'passed':
      return 'success';
    case 'failed':
      return 'error';
    case 'attention':
      return 'warning';
    case 'running':
      return 'accent';
    case 'pending':
      return 'textDim';
    default:
      return assertNever(state);
  }
}
