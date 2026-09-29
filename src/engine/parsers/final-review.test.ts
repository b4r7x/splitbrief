import { describe, expect, it } from 'vitest';
import { ReviewFindingCountsSchema, ReviewVerdictSchema } from '../../core/schemas/summary.js';
import { parseFinalReview } from './final-review.js';

const EXACT_FORMAT_REVIEW = `# Final Implementation Review

### Verdict
pass

### Criteria Results
- **[PASS]** Acceptance criteria are all satisfied -- the endpoint returns 201 for valid input
- **[PASS]** All inputs are handled and processing is correct
- **[FAIL]** Error handling misses the invalid-token case -- unauthenticated calls return 500 instead of 401

### Findings
- **Critical**: Unauthenticated requests return 500 instead of 401, breaking the error contract
- **Warning**: The retry loop can spin twice on a flaky connection
- **Note**: Consider extracting the guard into a shared helper

### Summary
Solid implementation overall; the error-handling gap needs a fix.`;

describe('parseFinalReview', () => {
  it('parses a review in the prompt exact format into verdict, criteria and findings', () => {
    const parsed = parseFinalReview(EXACT_FORMAT_REVIEW);

    expect(parsed.verdict).toBe('pass');
    expect(parsed.criteria).toEqual([
      {
        passed: true,
        text: 'Acceptance criteria are all satisfied -- the endpoint returns 201 for valid input',
      },
      { passed: true, text: 'All inputs are handled and processing is correct' },
      {
        passed: false,
        text: 'Error handling misses the invalid-token case -- unauthenticated calls return 500 instead of 401',
      },
    ]);
    expect(parsed.findings).toEqual([
      {
        severity: 'critical',
        text: 'Unauthenticated requests return 500 instead of 401, breaking the error contract',
      },
      { severity: 'warning', text: 'The retry loop can spin twice on a flaky connection' },
      { severity: 'note', text: 'Consider extracting the guard into a shared helper' },
    ]);
  });

  it('reports no verdict rather than guessing when no verdict section exists', () => {
    const parsed = parseFinalReview(
      `### Criteria Results
- **[PASS]** The build is green

### Findings
- **Warning**: Minor nit`,
    );

    expect(parsed.verdict).toBeNull();
    expect(parsed.criteria).toHaveLength(1);
    expect(parsed.findings).toHaveLength(1);
  });

  it('ignores verdict words that appear in prose outside the verdict section', () => {
    const parsed = parseFinalReview(
      `The implementation will pass all checks and could fail a stricter review.

### Verdict
pass_with_notes

### Criteria Results
- **[PASS]** The build is green`,
    );

    expect(parsed.verdict).toBe('pass_with_notes');
  });

  it('ignores findings bullets without a severity label', () => {
    const parsed = parseFinalReview(
      `### Verdict
fail

### Findings
- **Critical**: The module does not compile
- This finding has no severity label and must be ignored
- **Warning**: A minor issue`,
    );

    expect(parsed.findings).toEqual([
      { severity: 'critical', text: 'The module does not compile' },
      { severity: 'warning', text: 'A minor issue' },
    ]);
  });

  it('returns a null verdict when the verdict section carries more than one verdict word', () => {
    const parsed = parseFinalReview(
      `### Verdict
pass with minor notes -- not a fail, but close

### Findings
- **Note**: Nothing`,
    );

    expect(parsed.verdict).toBeNull();
  });

  it('produces every verdict the persisted review packet accepts, and no other', () => {
    const produced = ReviewVerdictSchema.options.map(
      (verdict) => parseFinalReview(`### Verdict\n${verdict}`).verdict,
    );

    expect(produced).toEqual([...ReviewVerdictSchema.options]);
    expect(parseFinalReview('### Verdict\ndefer').verdict).toBeNull();
  });

  // Verbatim from two canary reviews: the reviewer fills a severity label with "None." when the
  // category is empty, and the run must not send that line back as a Critical finding.
  it.each([
    {
      form: 'None.',
      review: `### Verdict
\`pass_with_notes\`

### Findings
- **Critical**: None.
- **Warning**: There is no recorded evidence for T001. The drift report's \`missing_evidence\` warning is accurate, because no Recorded Validation Output section was provided and I have no recorded test results to quote. I checked the file myself instead. My checks are reviewer observations, and they don't replace recorded results.
- **Note**: The brief's Tests section says "Run this from the project root. It should print nothing and exit 0" but never gives the \`diff\` command. The Evidence section also refers to a \`diff\` command that isn't in the brief. I reproduced the intent with \`grep\` matches against both source files. The \`xxd\` and anchored-regex checks were blocked by approval prompts, so I relied on \`wc -c\`.
- **Note**: Provenance is clean. The diff has one promotion (T001) with no operator edits or unknown-attribution hunks. The workspace diff equals the recorded diff, and its blob hash is \`84abf2f\`.`,
      severities: ['warning', 'note', 'note'],
    },
    {
      form: 'none.',
      review: `### Verdict
\`pass_with_notes\`

### Findings
- **Critical**: none.
- **Warning**: The deterministic drift report has \`[warning] missing_evidence: Task T001 expected evidence but none was observed\`. The brief's Evidence section asked for the output of the four test commands plus \`git status --short\`, and that output was not captured. I checked the substance independently (see the Note below), so the deliverable is correct, but the implementer's evidence trail is incomplete. This is why the verdict is \`pass_with_notes\` and not \`pass\`.
- **Note**: No Recorded Validation Output section was provided, so I make no claim about recorded test, typecheck or lint results. My checks below are reviewer observations only.
- **Note**: Two of the brief's test commands use process substitution (\`diff <(…) <(…)\`), which this sandbox rejected. I did not run them as written. I printed the SKILL.md token, the references token and the PROBE.md contents and compared them, and they match line for line. The other checks (\`wc -l\` printing \`2\`, and the whole-line \`grep -x\` count printing \`2\` in place of the anchored \`grep -c\`) ran and gave the expected results.
- **Note**: There is no separate operator or tool-fix hunk. Provenance shows PROBE.md as the only file with recorded run effects, and it lists no uncertain attribution or later edits.`,
      severities: ['warning', 'note', 'note', 'note'],
    },
  ])('reads a Critical label filled with $form as no finding', ({ review, severities }) => {
    const parsed = parseFinalReview(review);

    expect(parsed.verdict).toBe('pass_with_notes');
    expect(parsed.findings.map((finding) => finding.severity)).toEqual(severities);
  });

  it('reads an empty or dashed severity label as no finding, and a finding that starts with None as one', () => {
    const parsed = parseFinalReview(
      [
        '### Findings',
        '- **Critical**: None',
        '- **Critical**: ',
        '- **Warning**: —',
        '- **Critical**: None of the error paths are tested',
      ].join('\n'),
    );

    expect(parsed.findings).toEqual([
      { severity: 'critical', text: 'None of the error paths are tested' },
    ]);
  });

  it('reads N/A and Not applicable as no finding in every label style, and a finding about N/A as one', () => {
    const parsed = parseFinalReview(
      [
        '### Findings',
        '- **Critical**: N/A',
        '- **Critical:** n/a.',
        '- **Warning**: Not applicable — the brief changes no code.',
        '**Critical**',
        '- Not applicable.',
        '**Note:** N/A',
        '- **Critical**: N/A values in the config crash the parser',
      ].join('\n'),
    );

    expect(parsed.findings).toEqual([
      { severity: 'critical', text: 'N/A values in the config crash the parser' },
    ]);
  });

  // Verbatim from a Claude review: the colon sits inside the bold, and the file list under the
  // Warning is that finding's own detail.
  it('reads a label with the colon inside the bold and keeps the list under a finding as its detail', () => {
    const parsed = parseFinalReview(`### Findings
- **Warning:** The drift report lists six error-level \`out_of_scope_file\` findings that no T001 brief targets:
  - \`docs/API-KEYS.md\`
  - \`docs/TROUBLESHOOTING.md\`
  - \`src/engine/runners/prepare-execution/evaluate-candidate.ts\`
  - \`src/engine/runners/prepare-execution/prepare-execution.test.ts\`
  - \`src/engine/snapshots/files.ts\`
  - \`src/engine/snapshots/files.test.ts\`

  I treat these as false positives for this implementation, but I cannot prove it from the run record. They concern the \`auth_channel\` readiness block and the snapshot-walker stack overflow, both unrelated to \`RuleHeader\`. The \`CHANGELOG.md\` entries for those fixes were already in the working tree before the run, and each change ships with its own tests. They look like separate work in the same working tree. Confirm they were not made by the T001 implementer, and keep them out of the T001 commit.
- **Note:** T001's own diff is exactly the two in-scope files, \`src/components/rule-header.tsx\` and \`src/components/rule-header.test.tsx\`.
- **Note:** The escalation triggers did not fire. No call site or test depended on a single \`<Text>\` node, and no measured width changed. The test file does not touch the other three call sites' snapshots.
- **Note:** The visual look-and-logic check the project requires for user-visible changes (\`tui-shots\` for the \`overlay-settings*\` scenarios) should be run and its PNG read before shipping. \`t.text\` versus \`t.textDim\` under \`ansiTerminalTheme\` (\`white\` versus \`gray\` in \`terminalTheme\`) is only asserted by the SGR difference in the test.

### Summary`);

    expect(parsed.findings.map((finding) => finding.severity)).toEqual([
      'warning',
      'note',
      'note',
      'note',
    ]);
    expect(parsed.findings[0]?.text).toBe(
      'The drift report lists six error-level `out_of_scope_file` findings that no T001 brief targets:',
    );
  });

  // Verbatim from a canary review: the labels are empty and the findings are the bullets under them.
  it('reads the sub-bullets under an empty label as findings of that label', () => {
    const parsed = parseFinalReview(`### Findings
- **Critical**: None.
- **Warning**:
  - The drift report shows \`[warning] missing_evidence: Task T001 expected evidence but none was observed.\` The brief's Evidence section lists \`cat PROBE.md\` output, \`wc -l PROBE.md == 2\` and \`git status\`, and none were recorded. My own checks confirm the artifact is correct, but they are reviewer observations and do not replace the recorded evidence.
- **Note**:
  - No Recorded Validation Output section was provided, so test, typecheck and lint results were not recorded. I make no claims about them. The task has no code to test or type-check, so this only matters for the evidence gap above.
  - Provenance is clean. \`PROBE.md\` is the only file with recorded run effects. The Implementation Diff and the Workspace Context diff are byte-identical (\`index 0000000..4583883\`), so there are no later or operator edits to separate out.
  - The drift score was 0.92 with \`passed: true\`.

### Summary`);

    expect(parsed.findings.map((finding) => finding.severity)).toEqual([
      'warning',
      'note',
      'note',
      'note',
    ]);
    expect(parsed.findings.at(-1)?.text).toBe('The drift score was 0.92 with `passed: true`.');
  });

  // Verbatim from a Claude review that failed: each severity is a bold line over its bullets.
  it('reads the bullets under a bold severity line as findings of that severity', () => {
    const parsed = parseFinalReview(`### Verdict
\`fail\`

### Findings

**Critical**
- **T009 not executed.** \`testing/visual/catalog.ts\` is unmodified and no fresh PNGs exist. Criteria 18, 19, 20, 21 and the binding look-and-logic loop (spec Non-Functional: "Verification is visual, not only automated") are unmet. The preparation panel, usage-details and review overlays — three of the surfaces this change alters via the \`4 → 2\` gutter constant — were never looked at at all; no test in the diff covers them either.
- **Six error-level out-of-scope files.** \`src/engine/orchestrator/isolation/{create.ts,create.test.ts,types.ts}\`, \`task/run-implementation.ts\`, \`validation/format-error.{ts,test.ts}\` are substantive behaviour changes (a new \`fresh\` isolation-acquisition mode that *discards files*, and a change to validation error excerpting) with no brief authorising them. They are unrelated to scrollbars and rules. These are not false positives — they must be reverted or split into their own run. The ten \`info\`-level engine/runner findings are pre-existing working-tree state and correctly excluded.
- **\`npm test\` (full suite) never run.** Only filtered subsets are recorded. With \`computeListDisplayWindow\`'s return shape widened and seven surfaces re-widthed, a full-suite result is the minimum evidence for criterion 22.

**Warning**
- \`src/components/pickers/list-viewport.tsx:133\` — \`const rowContentWidth = contentWidth ?? Number.POSITIVE_INFINITY;\`. When \`width\` is absent, every consumer's \`renderItem\` receives \`Infinity\` as \`contentWidth\`; any of them forwarding it to a Box \`width\` or an arithmetic truncation budget produces a non-finite layout value rather than an obvious error. All seven consumers now pass \`width\`, so nothing hits it today — but it is a landmine for the eighth. Making \`width\` required (as the spec's Signature section actually specifies) removes it.
- The component's root element changed from \`<Box flexDirection="column">\` to \`<Box flexDirection="row">\` unconditionally — including when no bar is drawn. Ink flex parents that sized the old column root by its own growth may size the row differently. Not covered by any test and not verified by a render.
- The palette's label cap now recomputes \`Math.min(labelCeiling, floor(contentWidth * 0.5))\` once per row inside \`renderItem\`. Correct, but T006's escalation clause ("stop and ask if moving the cap changes the column where the list does not overflow") was never discharged by a render.

**Note**
- \`RuleHeader\`'s doc comment is now a 118-char single line; the repo's line width is 100 (biome \`lineWidth: 100\`). Lint passed, so it is inside the comment exemption, but it reads worse than the two-line form.

### Summary`);

    expect(parsed.verdict).toBe('fail');
    expect(parsed.findings.map((finding) => finding.severity)).toEqual([
      'critical',
      'critical',
      'critical',
      'warning',
      'warning',
      'warning',
      'note',
    ]);
  });

  // Verbatim from two Claude reviews: "None." with the reason after it is still an empty category.
  it('reads None with a reason after it as no finding, in every label style', () => {
    const parsed = parseFinalReview(`### Findings
- **Critical:** none. Drift report is empty; no error-level drift to treat as a blocker.

**Critical**
- None. Drift report is empty for T001–T003 (\`none\` on each attempt). No false-positive analysis required.`);

    expect(parsed.findings).toEqual([]);
  });

  // Verbatim titles from a Claude review that failed: each finding is a bold line over its body.
  it('reads a bold line that names its severity and a title as a finding', () => {
    const parsed = parseFinalReview(`### Findings

**Critical — the antigravity skill region was not regenerated with its argv (T016, criterion 36).**
\`skills/splitbrief/references/tool-recipes.md:107-110\` still generates \`agy … --print-timeout 20m …\`.

**Warning 1 — criterion 12 is met in behaviour but not literally.**
\`cli.ts:215\` passes \`timeoutMs: deadlineMs ?? CLI_NO_DEADLINE_MS\` instead of omitting the field.

**Note 3 — antigravity argv carries \`--output-format stream-json\`.**

### Summary`);

    expect(parsed.findings).toEqual([
      {
        severity: 'critical',
        text: 'the antigravity skill region was not regenerated with its argv (T016, criterion 36).',
      },
      { severity: 'warning', text: 'criterion 12 is met in behaviour but not literally.' },
      { severity: 'note', text: 'antigravity argv carries `--output-format stream-json`.' },
    ]);
  });

  it('reads a label line that is not a bullet, and never a bold word in prose', () => {
    const parsed = parseFinalReview(
      [
        '### Findings',
        '**Critical:** PROBE.md lacks a final newline',
        '**Warning:** none',
        '### Summary',
        '**Critical** issues were not found in the retry path.',
      ].join('\n'),
    );

    expect(parsed.findings).toEqual([
      { severity: 'critical', text: 'PROBE.md lacks a final newline' },
    ]);
  });

  // What reviewers write into an empty category: the canary runs, the re-verifier's samples,
  // and the same words wrapped in emphasis, inline code or parentheses.
  it.each([
    'None.',
    'None. Drift report is empty; no error-level drift to treat as a blocker.',
    'N/A — the brief changes no code.',
    'No critical issues found.',
    'No blocking findings; the drift report is clean.',
    '0',
    '-',
    '—',
    '_None._',
    '`none`',
    '(none)',
    '*No issues.*',
    'No problems identified.',
    'No concerns were found.',
    'No findings to report.',
    '–',
    'None of note.',
    'Nothing to report.',
    'Nothing found.',
    'Nothing of note.',
    'Nothing.',
  ])('reads a Critical label filled with %s as no finding', (fill) => {
    expect(parseFinalReview(`### Findings\n- **Critical**: ${fill}`).findings).toEqual([]);
  });

  it.each([
    'No tests cover the retry path',
    'No tests found for the new parser.',
    'No error handling issues were fixed in the retry path',
    'No issues with the parser, but the retry path swallows its error',
    'None of the error paths are tested',
    'None found except the inverted auth check',
    'None blocking, but the migration has no down step',
    'N/A values in the config crash the parser',
    'Nothing validates the token before it is written',
    '0 tests cover the retry path',
    '-1 is returned instead of throwing',
  ])('keeps %s as a Critical finding', (text) => {
    expect(parseFinalReview(`### Findings\n- **Critical**: ${text}`).findings).toEqual([
      { severity: 'critical', text },
    ]);
  });

  it('reads a label behind any bullet or indent, a titled bullet, a heading with text and a counted label', () => {
    const parsed = parseFinalReview(
      [
        '### Findings',
        '* **Critical**: a star bullet',
        '1. **Critical**: a numbered bullet',
        '2) **Warning**: a numbered bullet with a parenthesis',
        '  - **Critical**: an indented bullet',
        '- **Critical — a titled bullet**',
        '### Critical: a heading with text',
        '**Critical (1)**:',
        '- an item under a counted label',
        '- **Note**:',
        '  - a nested note',
        '    - a detail of the nested note',
        '  - another nested note',
        '- a bullet that is no finding',
      ].join('\n'),
    );

    expect(parsed.findings).toEqual([
      { severity: 'critical', text: 'a star bullet' },
      { severity: 'critical', text: 'a numbered bullet' },
      { severity: 'warning', text: 'a numbered bullet with a parenthesis' },
      { severity: 'critical', text: 'an indented bullet' },
      { severity: 'critical', text: 'a titled bullet' },
      { severity: 'critical', text: 'a heading with text' },
      { severity: 'critical', text: 'an item under a counted label' },
      { severity: 'note', text: 'a nested note' },
      { severity: 'note', text: 'another nested note' },
    ]);
  });

  it('reads a Critical in either label style and under an empty label', () => {
    const parsed = parseFinalReview(
      [
        '### Findings',
        '- **Critical:** PROBE.md lacks a final newline',
        '- **Critical**:',
        '  - hello.js was edited outside the brief',
        '### Critical',
        '- The retry loop never terminates',
      ].join('\n'),
    );

    expect(parsed.findings).toEqual([
      { severity: 'critical', text: 'PROBE.md lacks a final newline' },
      { severity: 'critical', text: 'hello.js was edited outside the brief' },
      { severity: 'critical', text: 'The retry loop never terminates' },
    ]);
  });

  it('produces every finding severity the packet finding counter tallies', () => {
    const severities = Object.keys(ReviewFindingCountsSchema.shape);
    const review = severities.map((severity) => `- **${severity}**: ${severity} body`).join('\n');

    const parsed = parseFinalReview(`### Findings\n${review}`);

    expect(parsed.findings).toEqual(
      severities.map((severity) => ({ severity, text: `${severity} body` })),
    );
  });
});
