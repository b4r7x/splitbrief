# Implementer Prompt

Everything the implementer ever sees. Lifted from the SPLITBRIEF CLI (`src/engine/spec/prompts/system.ts`, `src/engine/spec/prompt-formatter.ts`, `src/engine/spec/prompts/escalation.ts`). The implementer has no access to this session, the spec, or sibling briefs: if it is not in this rendering, the implementer does not know it.

The generated blocks below come from the CLI's prompt builders (`npm run skills:sync`, guarded by `npm run skills:check`), rendered with the TypeScript language context. The generator applies two substitutions because the skill has no isolation directory or promotion step: `isolation directory` → `working directory` (and the sentence `Your changes are promoted into the user's project afterwards.` is dropped), and `SPLITBRIEF runs them again after promotion` → `the orchestrator runs them again afterwards`. The CLI's `## Similar Issues` section (retrieved escalation examples) is omitted.

## 1. System preamble (direct mode — the tool edits files itself)

<!-- generated: implementer-preamble -->
    SYSTEM: You are a coding agent for TypeScript. You write clean, working code directly in the working directory.
    Rules:
    - Edit ONLY the file the Task Brief names, plus anything its Scope section lists under approved out-of-bounds. Every other file is out of bounds.
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

    ### Action: create | modify
    ### File: <brief file>

then the brief's sections, in this order and with these headings: `### Description`, `### Signature`, `### Type Definitions`, `### Pattern`, `### Implementation Steps` (numbered), `### Tests` (bulleted, ending with the Validation commands list), `### Scope`, `### Escalation`, `### Evidence`, `### Constraints`. Omit a heading whose section the brief does not have; never invent one. The four closing constraints from references/brief-format.md are appended to `### Constraints` only when the brief does not already end with them (briefs written by `splitbrief-brief` carry them; a CLI `tasks.md` brief does not).

## 3. Closing line

    Edit <file> directly in the working directory. Run the validation commands listed in this Task Brief before finishing. End with a completion report stating which files you wrote and whether the brief's steps were completed.

## 4. Retry rendering

A retry prompt is the preamble, then the framing and the error at the top of the body, then the body and the closing line:

    <preamble>

    <framing>

    Error from previous attempt:
    <gate tail or drift list, verbatim>

    ## Project: …
    <body as in §2>

    <closing line>

| Retry (within the current ladder) | Framing |
|---|---|
<!-- generated: retry-framings -->
| 1st local retry | `Your previous attempt had an error. Fix it:` |
| 2nd local retry | `Previous attempts failed. Here is the task rephrased differently:` |
| hint rung | `Multiple attempts have failed. Try a completely different approach:` |
<!-- /generated -->

The table is keyed on the retry's position in the current ladder, not on the file's attempt number: a review fix cycle starts a new ladder, so its first attempt uses the 1st-retry framing with the findings as the error even when it is `attempt-5`. On the 2nd local retry, rephrase `### Description` in different words; every other section stays verbatim.

On the hint rung the error block starts with `Hint from the planner:` followed by the hint text from `T00N/hint.md`, a blank line, and then the original error. Drift entries are rendered as `Revert your changes to <path>; only <brief file> may change`, one per line. A `recipe-fix` re-spawn (references/tool-recipes.md) uses no framing and no error block: it is the original prompt again.

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
- the brief's `file` is not in the changed set (`git status --porcelain --untracked-files=all` minus `baseline-tree.txt`), reason `brief file unchanged`;
- the final text says `changed nothing`, `no changes`, `Files written: none`, or lists no file, reason `implementer reported no change`.

Only an attempt that passes these checks runs the gates and the drift check.
