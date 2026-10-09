import { REVIEW_CHECK_ID } from '../schemas/review.js';
import type { Check, Task } from '../schemas/task.js';

const FIX_BRIEF_EVIDENCE_RULE =
  'Evidence, ledger, review and session files are not your job; SPLITBRIEF records them. You may edit any ordinary project file the fix needs.';
const FIX_BRIEF_NO_CHANGE_RULE =
  'If no finding needs a code change, change nothing and report that.';

export type FixFinding = NonNullable<Task['fix']>['findings'][number];

/** The reviewer checks a fix task re-runs, each by the exact command of the red it answers. */
export function fixReviewChecks(task: Task): Check[] {
  const checks = new Map<string, Check>();
  for (const finding of task.fix?.findings ?? []) {
    for (const id of finding.checkIds ?? []) {
      const command = finding.commands?.[id];
      if (REVIEW_CHECK_ID.test(id) && command !== undefined && !checks.has(id)) {
        checks.set(id, { id, kind: 'cmd', value: command, required: true });
      }
    }
  }
  return [...checks.values()];
}

/** A fence longer than any backtick run in the output, so the output cannot close it. */
function fenced(output: string): string {
  const longest = (output.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 2);
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${output}\n${fence}`;
}

export function fixBriefDescription(intent: string, findings: readonly FixFinding[]): string {
  const outputs = new Set(findings.flatMap((finding) => finding.output ?? []));
  return [
    intent,
    ...findings.map(
      (finding) =>
        `**${finding.id}**: ${finding.text}${
          finding.acceptance === null ? '' : `\nAcceptance: ${finding.acceptance}`
        }${Object.entries(finding.commands ?? {})
          .map(([id, command]) => `\nCommand ${id}: ${command}`)
          .join('')}`,
    ),
    ...[...outputs].map((output) => `Failing output:\n${fenced(output)}`),
    FIX_BRIEF_EVIDENCE_RULE,
    FIX_BRIEF_NO_CHANGE_RULE,
  ].join('\n\n');
}
