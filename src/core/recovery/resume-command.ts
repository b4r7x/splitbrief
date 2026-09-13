import type { RecoveryIssue } from '../schemas/recovery/schemas.js';

/**
 * The one line an operator can paste to carry on from a halt. Only the actions
 * `splitbrief continue` can take name themselves; every other recommendation
 * needs the panel, so the line resumes and says where the action lives.
 */
export function formatResumeCommand(sessionId: string, issue: RecoveryIssue): string {
  const flag = continueAction(issue);
  if (flag === undefined)
    return `splitbrief resume (${issue.recommendedAction} is available in the TUI)`;
  return `splitbrief continue ${sessionId} --action ${flag}`;
}

function continueAction(issue: RecoveryIssue): string | undefined {
  switch (issue.recommendedAction) {
    case 'skip-current-task':
      return 'skip';
    case 'retry-same-worker':
      return 'retry';
    case 'switch-seat': {
      const tool = issue.switchSeat?.candidates[0]?.tool;
      return tool === undefined ? undefined : `switch-seat:${tool}`;
    }
    default:
      return undefined;
  }
}
