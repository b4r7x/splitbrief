import type { Task } from '../schemas/task.js';

const FIX_BRIEF_EVIDENCE_RULE =
  'Evidence, ledger, review and session files are not your job; SPLITBRIEF records them. You may edit any ordinary project file the fix needs.';
const FIX_BRIEF_NO_CHANGE_RULE =
  'If no finding needs a code change, change nothing and report that.';

export type FixFinding = NonNullable<Task['fix']>['findings'][number];

export function fixBriefDescription(intent: string, findings: readonly FixFinding[]): string {
  return [
    intent,
    ...findings.map(
      (finding) =>
        `**${finding.id}**: ${finding.text}${
          finding.acceptance === null ? '' : `\nAcceptance: ${finding.acceptance}`
        }`,
    ),
    FIX_BRIEF_EVIDENCE_RULE,
    FIX_BRIEF_NO_CHANGE_RULE,
  ].join('\n\n');
}
