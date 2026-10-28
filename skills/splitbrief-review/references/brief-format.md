# Brief format, Product Task Brief v1

The Markdown brief is the implementer's contract. Render it from TaskSpec fields; send no task JSON to the implementer.

## Task grouping

<!-- generated: brief-grouping -->
One brief delivers one coherent, reviewable outcome. List every path that outcome writes under `files`. Keep the tests, callers, wiring, fixtures and necessary documentation with the behavior they cover; a file boundary alone never makes a separate brief. Combine related corrections that share a contract, mechanism or code context; a mechanical rename carries all its callers and pinned strings. Split independent outcomes, or a complex mechanism, when separate validation, context or recovery makes the work easier to execute correctly. Two assertions that can pass separately do not require separate briefs, and no file-count or line-count threshold decides a boundary. Keep each brief self-contained for its actual runner, with every acceptance criterion and repository constraint it needs, and within the real model context and prompt transport limits, system text, skills and retry feedback included. Do not aim for a number of briefs. Order the dependencies so each brief leaves its affected checks green.
<!-- /generated -->

## Markdown template and field homes

The generated template carries BRIEF_HOME_OF_FIELD from `src/engine/spec/prompts/task-format-example.ts`.
Keep its frontmatter keys and heading names exactly. Steps are advisory; omit numbered steps when steps is null.
Treat file/files as suggestions. Use Out of bounds for explicit exclusions, never as a file fence.
Use Approved out of bounds for further ordinary file guidance when needed. It grants no protected-write permission.
For protectedOperations, include the path and operation under Constraints. Record user confirmation separately.
Place batch ordering in depends_on. Keep the numeric batch and registered check objects in plan.json.

<!-- generated: brief-template -->
    Plan each brief as a task with these fields, then render each field in its place:

    - `id` → frontmatter `id`.
    - `title` → frontmatter `title`.
    - `intent` → `### Description`.
    - `criteria` → `### Evidence`: one bullet per acceptance criterion the brief serves, naming the check that proves it.
    - `checks` → `### Tests` for each test check, and `### Evidence` with one `<id> <kind>: <value>` bullet per check.
    - `suggestedFiles` → frontmatter `file` (the first one) and `files` (all of them).
    - `contextFiles` → one `### Read-only context (do not modify) — <path>` section per file, with its current code.
    - `exclusions` → `### Scope` under `**Out of bounds:**`.
    - `protectedOperations` → `### Constraints`: one `Protected write: <path> (the user confirms it before it lands)` bullet per operation.
    - `steps` → `### Implementation Steps`.
    - `dependsOn` → frontmatter `depends_on`.
    - `batch` → no field of its own: a brief of a later batch names the briefs it follows in `depends_on`.

    Frontmatter values are parsed literally. Never emit an alternation such as `create | modify` — choose one value:

    - `id` — unique brief id: `T001`, `T002`, ... in emission order.
    - `title` — one short line.
    - `action` — exactly `create` or `modify`. Use `modify` when `file` exists, otherwise `create`.
    - `file` — one project-relative path (no leading `/`, no `..`): the slice's anchor.
    - `files` — optional YAML list of every project-relative path the slice writes, `file` among them. Omit it when the slice writes only the anchor.
    - `depends_on` — YAML list of brief ids this one must follow: `[]` when independent, `[T001, T002]` when it must run after both.

    Copy this shape and substitute real values:

    ---
    id: T001
    title: Short descriptive title
    action: create
    file: src/path/to/file.ts
    files: [src/path/to/file.ts, src/path/to/file.test.ts]
    depends_on: []
    ---

    ### Description
    What to implement and why. Include all context the implementer needs.

    **Plan context (read-only):**
    <plan summary>
    Decisions: <plan decisions, including task ids>
    Criteria this task serves: <criterion ids and text>

    ### Signature
    ```typescript
    export function exampleFn(param: Type): ReturnType
    ```

    ### Type Definitions
    ```typescript
    // All referenced types, copied verbatim
    ```

    ### Read-only context (do not modify) — src/path/to/context.ts
    ```typescript
    // The current code of a context file the change reads but does not write
    ```

    ### Pattern
    Existing codebase pattern or exact snippet the implementer should follow.

    ### Implementation Steps
    1. Step-by-step HOW to implement
    2. Specific function calls and patterns

    ### Tests
    - Test case with concrete inputs/outputs

    ### Scope
    **Out of bounds:**
    - Explicit exclusion the reviewer checks
    **Approved out of bounds:**
    - A further ordinary file the planner suggests

    ### Escalation
    - Stop and report to the planner when the required behavior is ambiguous, when a dependency is missing, or when the brief conflicts with local code.

    ### Evidence
    - Reviewable proof the task completed (the focused tests that pass, the changed files, the behavior a reviewer can check).

    ### Constraints
    - ESM imports with .js extensions
    - Follow existing codebase patterns

    **Implementer report:**
    The report is advisory. Recorded checks decide whether the task passes.
    End with one JSON object and nothing after it. Use decisions: [] when you propose no deviation.
    {"status":"done","filesChanged":["<file>"],"touchedNotSuggested":[{"file":"<file>","reason":"<reason>"}],"notes":null,"decisions":[{"what":"<proposed deviation>","why":"<reason>"}]}
    If blocked, end with {"status":"blocked","question":"<question>","filesNeeded":["<file>"]} instead. The session consults at once.
    A decision states a deviation and why. The plan ledger records it with the task id, and the reviewer judges it.
    No proposed deviation: {"status":"done","filesChanged":["<file>"],"touchedNotSuggested":[],"decisions":[],"notes":null}
<!-- /generated -->

Use the project's language and import convention in code examples.
Copy signature, types and pattern from current code when relevant.
Attach the current code of contextFiles in their read-only context sections.

## Plan context and report placement

Keep Plan context in the bold subsection inside Description shown above.
Its summary, the decisions with task ids, and criterion text come from references/planning.md.
Append the report from references/implementer-prompt.md after Constraints under the bold label.
Neither subsection adds a Task Brief heading or frontmatter key.
Record validation commands and sources in Constraints as session-run commands, per references/gates.md.
Carry the workspace rules and project instructions into each self-contained brief.

## Parser and artifacts

Use bare `---` only for frontmatter delimiters outside fenced code. Never wrap the whole tasks document in a code fence.
The strict parser reads the contract. Read-only context sections stay in the raw brief sent to the implementer.
The current parser can warn about those context headings; it does not retain their code in its parsed Task.
Keep typed fields in plan.json. Do not reconstruct them from a parsed Task alone.
CLI tasks.md omits criteria, protectedOperations and batch; load its adjacent plan.json.

    <run>/plan.json · plan.md · tasks.md · plan-inputs.json
    <run>/briefs/index.md         | id | title | file | action | depends_on |
    <run>/briefs/T001.md          one Markdown brief per behaviour

Use the same rendered briefs in tasks.md. Preserve dependencies when appending fixes or replacing split parents.
