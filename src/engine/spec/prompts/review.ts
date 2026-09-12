import { buildPrompt, fenced, instructionsSection } from './builder.js';

const REVIEW_INSTRUCTIONS = `Review the implementation diff against every acceptance criterion and requirement in the spec and task briefs. Be thorough but fair -- minor style differences are acceptable; missing functionality or incorrect behavior is not.

Validation claims are evidence-bound. Any statement about test, typecheck, or lint results must quote the relevant line verbatim from the Recorded Validation Output section (for example the test runner's own summary line); never report counts or totals that do not appear there. If you run additional checks yourself, present them separately as reviewer observations -- they do not replace the recorded results. If no Recorded Validation Output section is present, state that validation output was not recorded instead of asserting results.`;

const REVIEW_CHECKLIST = `1. **Acceptance Criteria**: Check each criterion from the spec and task briefs. Is it satisfied by the implementation?
2. **Functional Requirements**: Are all inputs handled? Is processing correct? Are outputs as specified?
3. **Error Handling**: Are error cases handled as specified?
4. **Edge Cases**: Are boundary conditions addressed?
5. **Type Safety**: Are types correct and complete?
6. **Code Quality**: Are there obvious bugs, security issues, or performance problems?`;

const REVIEW_OUTPUT = `Respond with exactly this structure:

### Verdict
One of: \`pass\` | \`pass_with_notes\` | \`fail\`

### Criteria Results
For each acceptance criterion from the spec:
- **[PASS]** or **[FAIL]** Criterion description -- brief explanation

### Findings
List any issues found, categorized as:
- **Critical**: Breaks functionality or violates a requirement (causes \`fail\` verdict)
- **Warning**: Works but has potential issues (allowed in \`pass_with_notes\`)
- **Note**: Minor observations, suggestions for improvement (informational only)

### Summary
One-paragraph overall assessment.`;

const MAX_DIFF_CHARS = 100_000;

/**
 * One prompt budget for the diff, shared by the workflow's final review and the
 * one-shot `review` command so a reader comparing the two knows which applied.
 */
export function truncateDiffForPrompt(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  const omitted = diff.length - MAX_DIFF_CHARS;
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[... diff truncated, ${omitted} characters omitted ...]`;
}

const VALIDATION_EVIDENCE_PREAMBLE = `The orchestrator ran these validation commands and recorded their output. This section is the authoritative record of validation results for this run.`;

export function buildFinalReviewPrompt(opts: {
  spec: string;
  taskBriefs: string;
  diff: string;
  driftReport?: string | undefined;
  validationEvidence?: string | undefined;
}): string {
  const sections = [
    { heading: 'Specification', body: opts.spec },
    { heading: 'Task Briefs', body: opts.taskBriefs },
    { heading: 'Implementation Diff', body: fenced(opts.diff, 'diff') },
  ];
  if (opts.driftReport) {
    sections.push({ heading: 'Deterministic Drift Report', body: opts.driftReport });
  }
  if (opts.validationEvidence) {
    sections.push({
      heading: 'Recorded Validation Output',
      body: `${VALIDATION_EVIDENCE_PREAMBLE}\n\n${opts.validationEvidence}`,
    });
  }
  sections.push(
    instructionsSection(REVIEW_INSTRUCTIONS),
    { heading: 'Review Checklist', body: REVIEW_CHECKLIST },
    { heading: 'Output Format', body: REVIEW_OUTPUT },
  );
  return buildPrompt({
    title: 'Final Implementation Review',
    intro:
      'You are reviewing a completed implementation against its specification. Your job is to verify that the implementation satisfies the spec and identify any issues. Treat error-level drift findings as review blockers unless you can clearly explain why they are false positives.',
    sections,
  });
}
