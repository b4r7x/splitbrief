# Review Format

The review seat is one stateless, read-only call. Lifted from the SPLITBRIEF CLI (`src/engine/spec/prompts/review.ts`, `src/engine/parsers/final-review.ts`). A reviewer tool receives the packet as its prompt; when `review: session`, the session answers the same prompt from the packet file, never from memory of the run.

## 1. Packet (`<run dir>/review-packet.md`)

<!-- generated: review-packet -->
    # Final Implementation Review

    You are reviewing a completed implementation against its specification. Your job is to verify that the implementation satisfies the spec and identify any issues. Treat error-level drift findings as review blockers unless you can clearly explain why they are false positives.

    ## Specification
    <spec.md when it exists; otherwise, per brief: `### T001 — <title>` + its Description, Tests, Scope>

    ## Task Briefs
    <every brief in full>

    ## Implementation Diff
    ```diff
    <git diff of the changed set against the baseline tree; untracked new files via `git diff --no-index /dev/null <file>`>
    ```

    ## Deterministic Drift Report
    <drift.md content, or `No drift: every changed file is owned by a brief.`>

    ## Recorded Validation Output
    The orchestrator ran these validation commands and recorded their output. This section is the authoritative record of validation results for this run.

    <per brief: `### T001 — attempt N` then, per stage, the command on its own line and its captured output fenced>

    ## Instructions
    Review the implementation diff against every acceptance criterion and requirement in the spec and task briefs. Be thorough but fair -- minor style differences are acceptable; missing functionality or incorrect behavior is not.

    Validation claims are evidence-bound. Any statement about test, typecheck, or lint results must quote the relevant line verbatim from the Recorded Validation Output section (for example the test runner's own summary line); never report counts or totals that do not appear there. If you run additional checks yourself, present them separately as reviewer observations -- they do not replace the recorded results. If no Recorded Validation Output section is present, state that validation output was not recorded instead of asserting results.

    ## Review Checklist
    1. **Acceptance Criteria**: Check each criterion from the spec and task briefs. Is it satisfied by the implementation?
    2. **Functional Requirements**: Are all inputs handled? Is processing correct? Are outputs as specified?
    3. **Error Handling**: Are error cases handled as specified?
    4. **Edge Cases**: Are boundary conditions addressed?
    5. **Type Safety**: Are types correct and complete?
    6. **Code Quality**: Are there obvious bugs, security issues, or performance problems?

    ## Output Format
    Respond with exactly this structure:

    ### Verdict
    One of: `pass` | `pass_with_notes` | `fail`

    ### Criteria Results
    For each acceptance criterion from the spec:
    - **[PASS]** or **[FAIL]** Criterion description -- brief explanation

    ### Findings
    List any issues found, categorized as:
    - **Critical**: Breaks functionality or violates a requirement (causes `fail` verdict)
    - **Warning**: Works but has potential issues (allowed in `pass_with_notes`)
    - **Note**: Minor observations, suggestions for improvement (informational only)
    A **Critical** finding must name a defect in the code, the tests, or the behavior the diff produces. A missing entry in the evidence ledger (expected versus observed evidence), missing renders, screenshots or critiques, and missing process records are at most **Note**s: SPLITBRIEF records only its own validation facts and no seat can add render evidence to the ledger, so an evidence gap alone never causes `fail`.
    Write `None.` after the label of a category with no findings, or leave the label out.

    ### Summary
    One-paragraph overall assessment.
<!-- /generated -->

## 2. Parsing the reply (`review.md`)

<!-- generated: verdict-rules -->
- Exactly one verdict word under `### Verdict`: `pass` | `pass_with_notes` | `fail`.
- No single verdict word → 1 re-ask, verbatim: "Your reply had no single verdict. Repeat the full review with exactly one verdict word under ### Verdict." — a still-unparseable reply is `fail`.
- Any Critical finding overrides a `pass`.
- A Critical finding names a code, test or behavior defect; an evidence-record gap alone is at most a Note and never causes `fail`.
- A finding belongs to the brief whose `files` names it (path substring); an unmatched finding goes to the last brief.
<!-- /generated -->

Criteria are every line matching `- **[PASS]** …` / `- **[FAIL]** …` anywhere in the reply. A finding is a line that carries its label, behind a `-`, `*` or `1.` bullet or none (`- **Critical**: …`, `**Critical:** …`, `**Critical — title**`, `### Critical: …`), or a bullet under a label that stands alone (the sub-bullets of an empty `- **Critical**:`, the bullets under a `**Critical**` line or a `### Critical` heading). `None.`, `None of note`, `N/A`, `Not applicable`, `Nothing to report`, `No critical issues found`, `0`, a dash or nothing after a label is an empty category, not a finding, also inside emphasis, inline code or parentheses.

## 3. Fix cycle mapping

Each Critical finding is assigned to the brief whose `files` names it (path substring match); unmatched findings go to the last brief. Warnings and Notes are reported, never fixed automatically. Standalone, the same cycle is `splitbrief-run impl=<seat> error: <run dir>/review.md <run dir>/briefs`.

<!-- generated: fix-cycle -->
- A `fail` verdict re-enters implementation: each Critical finding becomes the error block of the next attempt on its owning brief.
- At most 2 review cycles; the last `fail` ends the run as `STOPPED at review` with the findings listed.
<!-- /generated -->

## 4. Review by the session

Write the packet file first, then answer it in one pass reading only that file and the working tree. Never cite what you remember from the run; cite the packet. The reply is written to `review.md` exactly as a tool's reply would be.
