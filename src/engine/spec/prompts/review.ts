import {
  buildPrompt,
  fenced,
  instructionsSection,
  skillsSection,
  type PromptPart,
} from './builder.js';

const REVIEW_INSTRUCTIONS = `Review the implementation diff against every acceptance criterion and requirement in the spec and task briefs. Be thorough but fair -- minor style differences are acceptable; missing functionality or incorrect behavior is not.

Validation claims are evidence-bound. Any statement about test, typecheck, or lint results must quote the relevant line verbatim from the Recorded Validation Output section (for example the test runner's own summary line); never report counts or totals that do not appear there. If you run additional checks yourself, present them separately as reviewer observations -- they do not replace the recorded results. If no Recorded Validation Output section is present, state that validation output was not recorded instead of asserting results.`;

const PROVENANCE_INSTRUCTIONS = `Use the Changed Files provenance to distinguish recorded run effects from workspace context. Do not attribute the whole workspace diff to the implementer. Independent operator or tool-fix hunks are context, including when they share a declared file with run changes; unrelated defects in those hunks alone do not fail this run. Evaluate the requested behavior in the integrated current workspace, including cross-file dependencies. A regression caused by a run effect, a broken interaction with existing code, or an unmet acceptance criterion still fails review. Keep unknown and overlapping edits explicit; if missing provenance or context prevents a required judgment, report that limit and fail that criterion rather than assuming it passed.`;

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
A **Critical** finding must name a defect in the code, the tests, or the behavior the diff produces. A missing entry in the evidence ledger (expected versus observed evidence), missing renders, screenshots or critiques, and missing process records are at most **Note**s: SPLITBRIEF records only its own validation facts and no seat can add render evidence to the ledger, so an evidence gap alone never causes \`fail\`.
Write \`None.\` after the label of a category with no findings, or leave the label out.

### Summary
One-paragraph overall assessment.`;

const VALIDATION_EVIDENCE_PREAMBLE = `The orchestrator ran these validation commands and recorded their output. This section is the authoritative record of validation results for this run.`;

export function buildFinalReviewPrompt(opts: {
  spec: string;
  taskBriefs: string;
  diff: string;
  driftReport?: string | undefined;
  validationEvidence?: string | undefined;
  /**
   * What the run changed and what the diff below covers. A seat that reads no
   * files of its own is told the scope it is judging instead of inferring it.
   */
  changeCoverage?: string | undefined;
  /** Whole current workspace diff, retained beside the separately attributed effects. */
  workspaceDiff?: string | undefined;
  skillsContext?: string | undefined;
}): string {
  const sections: PromptPart[] = [
    { heading: 'Specification', body: opts.spec },
    { heading: 'Task Briefs', body: opts.taskBriefs },
    ...skillsSection(opts.skillsContext),
  ];
  if (opts.changeCoverage) {
    sections.push({ heading: 'Changed Files', body: opts.changeCoverage });
  }
  sections.push({ heading: 'Implementation Diff', body: fenced(opts.diff, 'diff') });
  if (opts.workspaceDiff !== undefined) {
    sections.push({ heading: 'Workspace Context', body: fenced(opts.workspaceDiff, 'diff') });
  }
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
    instructionsSection(
      opts.workspaceDiff === undefined
        ? REVIEW_INSTRUCTIONS
        : `${REVIEW_INSTRUCTIONS}\n\n${PROVENANCE_INSTRUCTIONS}`,
    ),
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
