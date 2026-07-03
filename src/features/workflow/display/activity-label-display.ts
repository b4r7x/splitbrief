import type { RunnerActivityLedgerLabel } from './runner-activity-display.js';

export const ACTIVITY_LABEL_PAD = 6;

const ACTIVITY_LABEL_DISPLAY: Record<RunnerActivityLedgerLabel, string> = {
  RUN: 'Run',
  READ: 'Read',
  EDIT: 'Edit',
  FIND: 'Search',
  CALL: 'Call',
  PLAN: 'Plan',
  SESS: 'Sess',
  ART: 'Art',
  WARN: 'Warn',
  ERR: 'Err',
  LIST: 'List',
};

export function displayActivityLabel(label: RunnerActivityLedgerLabel): string {
  return ACTIVITY_LABEL_DISPLAY[label];
}
