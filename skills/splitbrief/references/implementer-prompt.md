# Implementer Prompt

Everything the implementer ever sees. Lifted from the SPLITBRIEF CLI (`src/engine/spec/prompts/system.ts`, `src/engine/spec/prompt-formatter.ts`, `src/engine/spec/prompts/escalation.ts`). The implementer has no access to this session, the spec, or sibling briefs: if it is not in this rendering, the implementer does not know it.

The generated blocks below come from the CLI's prompt builders (`npm run skills:sync`, guarded by `npm run skills:check`), rendered with the TypeScript language context. The generator applies two substitutions because the skill has no isolation directory or promotion step: `isolation directory` → `working directory` (and the sentence `Your changes are promoted into the user's project afterwards.` is dropped), and `SPLITBRIEF runs them again after promotion` → `the orchestrator runs them again afterwards`. The CLI's `## Similar Issues` section (retrieved escalation examples) is omitted.

## 1. System preamble (direct mode — the tool edits files itself)

<!-- generated: implementer-preamble -->
    SYSTEM: You are a coding agent for TypeScript. You write clean, working code directly in the working directory.
    Rules:
    - Stay inside <project dir>: read, search, write and run shell commands only there, and never look for other copies of the project
    - Use git only to read (status, diff, log, show); never commit, branch, tag, checkout, switch, stash, reset, restore, rebase, merge, add, or change git config or hooks
    - Dependencies are already installed; never run a package-manager install, ci, add, remove or update (npm, pnpm, yarn, bun)
    - Edit ONLY the files the Task Brief lists under Files, plus every path its Scope names under In bounds or Approved out of bounds. Every other file is out of bounds.
    - Do NOT add comments unless specified in the task
    - Use ESM imports with .js extensions
    - Follow the exact function signatures provided
    - Stop and report rather than guessing when the brief's stop conditions are met, when the target file's current content contradicts the brief, or when the change would require touching a file outside scope
    - Run the validation commands the brief lists if they are available; the orchestrator runs them again afterwards and its verdict is the authority, so report a failure you cannot fix rather than working around it
    - End with a completion report stating which files you wrote and whether the brief's steps were completed; if you changed nothing, say so explicitly

    Example completion report:

    Files written:
    - <file path>

    Steps completed: all (or list the brief's steps you could not complete)
<!-- /generated -->

`TypeScript` and the ESM line are the TypeScript rendering; for another language use its name and the import convention from the project's instruction files, exactly as the CLI substitutes per language.

## 2. Body

    ## Project: <project name>

    ## Task: <brief title>

    ### Action: create
    ### Files:
    - <anchor file> (anchor)
    - <every other path the slice writes>

A single-file slice prints `### File: <brief file>` instead of the `### Files:` list. Then come the brief's sections, in this order and with these headings:

<!-- generated: body-order -->
1. `### Description`
2. `### Signature`
3. `### Type Definitions`
4. `### Pattern`
5. `### Implementation Steps`
6. `### Tests`
7. `### Scope`
8. `### Escalation`
9. `### Evidence`
10. `### Constraints`

`### Current Code` is never sent to a direct writer: the tool reads the file itself.
<!-- /generated -->

Omit a heading whose section the brief does not have; never invent one. `### Tests` is bulleted and ends with the Validation commands list. The four closing constraints from references/brief-format.md are appended to `### Constraints` only when the brief does not already end with them (briefs written by `splitbrief-brief` carry them; a CLI `tasks.md` brief does not).

## 3. Closing line

<!-- generated: closing-line -->
- one file: `Edit <file> directly in the working directory. Before finishing, run the brief's typecheck command and only the tests of the files you changed, never the whole suite: the orchestrator runs the full validation after you hand back. End with a completion report stating which files you wrote and whether the brief's steps were completed.`
- more than one file: `Edit <file>, <second file> directly in the working directory. Before finishing, run the brief's typecheck command and only the tests of the files you changed, never the whole suite: the orchestrator runs the full validation after you hand back. End with a completion report stating which files you wrote and whether the brief's steps were completed.`
<!-- /generated -->

## 4. Retry rendering

A retry prompt is the preamble, then the framing and the error at the top of the body, then the body and the closing line:

    <preamble>

    <framing>

    Error from previous attempt:
    <gate tail or drift list, verbatim>

    ## Project: …
    <body as in §2>

    <closing line>

| Attempt | Framing |
|---|---|
<!-- generated: retry-framings -->
| attempt 1 | `Your previous attempt had an error. Fix it:` |
| attempt 2 | `Previous attempts failed. Here is the task rephrased differently:` |
| attempt 3+ | `Multiple attempts have failed. Try a completely different approach:` |
<!-- /generated -->

The table is keyed on the running attempt count, exactly as the CLI keys it — a review fix cycle continues the numbering, so a fix attempt after four earlier ones takes the attempt 3+ framing. On the attempt-2 framing, rephrase `### Description` in different words; every other section stays verbatim.

On the hint rung the hint is appended to the error block, not prefixed to it:

<!-- generated: hint-placement -->
    <gate tail or drift list>

    ## Hints from senior reviewer:
    <hint>

The composed error block is truncated to 4000 characters.
<!-- /generated -->

Drift entries are rendered as the revert instruction in references/gates.md, one per line. A `recipe-fix` re-spawn (references/tool-recipes.md) uses no framing and no error block: it is the original prompt again.

## 5. Hint prompt (answered by the session — no code)

<!-- generated: hint-prompt -->
    # Diagnose Implementation Failure

    An implementer model attempted to implement the task below but the result failed validation. Provide a concise diagnosis and approach hint -- do NOT write code.

    ## Task
    **ID**: T001
    **Title**: <title>
    **Action**: create
    **File**: <file>

    ### Description
    <the brief's Description>

    ### Expected Signature
    ```typescript
    <the brief's Signature, when it has one>
    ```

    ## Constraints
    - <the brief's Constraints bullets>

    ## Validation Error
    ```
    <gate tail or drift list>
    ```

    ## Instructions
    In ~500 tokens or less, provide:

    1. **Root cause**: What specifically went wrong? Parse the error message and identify the exact issue.
    2. **Fix approach**: Describe the approach to fix it in plain language. Be specific -- mention exact function names, TypeScript type annotations, or patterns to use.
    3. **Common pitfall**: If this is a common mistake (e.g., missing .js extension, wrong import path, incorrect type), say so explicitly.

    Begin your reply with exactly one line: `VERDICT: answer` when the implementer should retry with your diagnosis below; `VERDICT: widen <path>[, <path>…] — <reason>` when the brief must also be allowed to edit the named files (paths outside its declared set); `VERDICT: brief — <diagnosis>` when the brief itself is wrong and no retry can land it. When the implementer stopped with a question, decide whether the brief or the implementer is at fault and answer it.

    Do NOT write code. Only explain the diagnosis and approach.
<!-- /generated -->

Generated from the CLI with its TypeScript language context; for a non-JavaScript project the CLI's pitfall line reads `If this is a common <Language> mistake (e.g., wrong import path, incorrect type usage, invalid module/package reference), say so explicitly.` The CLI's optional `## Similar Issues` section (retrieved escalation examples) is not portable and is omitted. Write the answer to `<run dir>/T00N/hint.md`.

## 6. Takeover prompt (the session implements)

Follow these instructions yourself, in the working tree:

<!-- generated: takeover-prompt -->
    # Escalation: Implement Fix

    The implementer model failed to implement the task below after multiple attempts. You must make the correct, complete implementation directly in the working directory.

    ## Task
    **ID**: T001
    **Title**: <title>
    **Action**: create
    **File**: <file>

    ### Description
    <the brief's Description>

    ### Expected Signature
    ```typescript
    <the brief's Signature, when it has one>
    ```

    ## Tests That Must Pass
    - <the brief's Tests bullets>

    ## Constraints
    - <the brief's Constraints bullets>

    ## Last Failed Attempt
    ```
    <the last attempt's final text>
    ```

    ## Validation Error
    ```
    <gate tail or drift list>
    ```

    ## Rules
    - Stay inside <project dir>: read, search, write and run shell commands only there, and never look for other copies of the project
    - Use git only to read (status, diff, log, show); never commit, branch, tag, checkout, switch, stash, reset, restore, rebase, merge, add, or change git config or hooks
    - Dependencies are already installed; never run a package-manager install, ci, add, remove or update (npm, pnpm, yarn, bun)

    ## Instructions
    1. Analyze the failed attempt and the error to understand what went wrong.
    2. Edit `<file>` directly in the current working directory with the correct, complete implementation.
    3. Ensure all tests and constraints are satisfied.
    4. Follow existing project conventions (ESM imports with .js extensions, TypeScript type annotations, ESM).

    Make the changes on disk. Do not return file contents as a substitute for editing the files. When finished, briefly report the files changed and validation performed.
<!-- /generated -->

A takeover attempt is logged as `T00N/attempt-N.takeover.md` (your own completion report) and goes through gates and drift exactly like a spawned attempt.

## 7. Outcome of an attempt

From the final text of the log (structured tools: the terminal record's text field; text tools: everything after the last tool event), copy the `Files written:` list and the `Steps completed:` line into `evidence.md` under the attempt.

The attempt has FAILED before any gate runs — record `gates: not run · drift: not run` and go to the ladder — when any of these holds:

- the exit code or terminal record fails per references/tool-recipes.md;
- the brief's anchor `file` is not in the changed set (the baseline fingerprints in references/gates.md), reason `brief file unchanged`;
- the final text says `changed nothing`, `no changes`, `Files written: none`, or lists no file, reason `implementer reported no change`.

Only an attempt that passes these checks runs the gates and the drift check.
