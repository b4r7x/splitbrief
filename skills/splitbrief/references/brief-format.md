# Brief Format — Product Task Brief v1

The brief is the contract between the planner (this session) and the implementer (a different tool with no access to this session). Lifted from the SPLITBRIEF CLI (`src/engine/spec/prompts/task-format-example.ts`, `src/engine/spec/prompts/tasks.ts`). One brief = one verifiable slice = one implementer run.

## Template

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
    3. 3-5 steps max

    ### Tests
    - Test case with concrete inputs/outputs

    ### Scope
    **Out of bounds:**
    - Explicit exclusion the reviewer checks
    **Approved out of bounds:**
    - A further path the planner already approved

    ### Escalation
    - Stop and ask when the required behavior is ambiguous, when a dependency is missing, or when the brief conflicts with local code.

    ### Evidence
    - Reviewable proof the task completed (the focused tests that pass, the changed files, the behavior a reviewer can check).

    ### Constraints
    - ESM imports with .js extensions
    - Follow existing codebase patterns
<!-- /generated -->

The fenced examples are TypeScript. For Python, Go, Rust, or JavaScript use that language's fence and idioms — the CLI substitutes the Signature, Type Definitions, and read-only context examples per language.

## Brief Contract (required semantics)

<!-- generated: brief-contract -->
Every brief must cover these nine semantic sections, even when one is brief. Each section renders the plan task fields the template maps to it:

1. **Identity** — frontmatter `id`, `title`, `action`, `file`, optional `files`, `depends_on`, from the task's `id`, `title`, `suggestedFiles` and `dependsOn`.
2. **Intent** — `### Description`: the task's `intent`, what the change is and why it matters.
3. **Scope** — `### Scope` with `**Out of bounds:**` and optional `**Approved out of bounds:**` bullet lists, from the task's `exclusions`. REQUIRED. `files` are the suggested files; **Out of bounds** lists the explicit exclusions the reviewer checks.
4. **Code Context** — `### Signature`, `### Type Definitions` and `### Pattern`, copied verbatim from the project when relevant, and one `### Read-only context (do not modify) — <path>` section with the current code of each of the task's `contextFiles`. The implementer reads the files it suggests itself, and searches only for a symbol the brief names.
5. **Implementation Plan** — `### Implementation Steps`: the task's `steps`, 3-5 numbered steps with concrete function calls and patterns.
6. **Validation** — `### Tests`: the task's test checks, REQUIRED concrete test cases with specific inputs and expected outputs, in every brief. No phrases like "should work correctly", and no deferring the cases to whichever brief owns the test file.
7. **Constraints** — `### Constraints`: invariants, dependency rules, ESM imports with .js extensions, refusal conditions, and the task's `protectedOperations` as protected writes the user confirms.
8. **Escalation** — `### Escalation`: bullets describing when the implementer must stop and ask instead of guessing. Required whenever the brief contains plausible ambiguity.
9. **Evidence** — `### Evidence`: the task's checks and the criteria they prove, REQUIRED bullets describing the reviewable proof that should exist when the brief is done (the focused tests that pass, the changed files, the behavior a reviewer can check). Renders and project-wide gates are the review seat's and SPLITBRIEF's evidence, not the implementer's steps.

Every brief must also leave typecheck, lint and tests green on its own. Never plan for a failing gate: when a change would break a sibling file, widen the brief's `files` to include it, keep the change backward compatible with an optional property and a default, or split the work so each brief lands whole. Before a brief deletes or renames an export, its `files` name every consumer found by searching the whole repository — `src/` and `testing/` alike, colocated and sibling tests included.
<!-- /generated -->

## Critical Rules

<!-- generated: critical-rules -->
1. **Self-contained**: Each brief must inline the context the implementer cannot read in the files it suggests: the current code of its context files, TypeScript type annotations, import paths, function signatures from dependencies, and expected patterns.

2. **Coherent**: One brief delivers one coherent, reviewable outcome. List every path that outcome writes under `files`. Keep the tests, callers, wiring, fixtures and necessary documentation with the behavior they cover; a file boundary alone never makes a separate brief. Combine related corrections that share a contract, mechanism or code context; a mechanical rename carries all its callers and pinned strings. Split independent outcomes, or a complex mechanism, when separate validation, context or recovery makes the work easier to execute correctly. Two assertions that can pass separately do not require separate briefs, and no file-count or line-count threshold decides a boundary. Keep each brief self-contained for its actual runner, with every acceptance criterion and repository constraint it needs, and within the real model context and prompt transport limits, system text, skills and retry feedback included. Do not aim for a number of briefs. Order the dependencies so each brief leaves its affected checks green.

3. **Dependency-ordered**: Briefs must be ordered so dependencies come first. Use `depends_on` to declare which briefs must complete first; a brief of a later batch names the briefs it follows. Independent briefs can run in parallel.

4. **Concrete validation**: Every `### Tests` block must list specific test cases with concrete inputs and expected outputs, as `-` bullets. This holds for every brief, including one whose test file a different brief owns: list the cases that verify THIS brief's change. Never replace the bullets with prose that defers validation to another brief. Name the focused test files and cases only. SPLITBRIEF runs typecheck, lint and the affected tests after every brief, so never tell the implementer to run a project-wide gate, the whole suite, or a screenshot/render tool.

5. **Inline type definitions**: Copy referenced TypeScript type annotations or data shape definitions verbatim into `### Type Definitions`. Max ~300 tokens — prioritize definitions that appear in the function signature.

6. **Import paths**: Specify exact imports using ESM imports with .js extensions.

7. **Escalation, not guessing**: If a brief could be interpreted multiple ways, list those decision points under `### Escalation` rather than baking a guess into the steps.

8. **Evidence is not implementation**: `### Evidence` describes the proof that survives after the brief is done, not the steps that produce it.

9. **Reserved delimiter**: Outside fenced code blocks, lines containing only `---` are reserved for Task Brief frontmatter delimiters. Never use a bare `---` as a horizontal rule or phase-heading separator.
<!-- /generated -->

The three blocks above are generated from the CLI with its TypeScript language context (`npm run skills:sync`; `npm run skills:check` fails when they drift). One reading differs in the skill: the TypeScript-specific wording (`TypeScript type annotations`, `ESM imports with .js extensions`) becomes the project language's own convention for other languages.

## Skill additions (appended by this pipeline, never by the planner's judgment)

- `### Tests` ends with `**Validation commands:**` — the gates resolved in Phase 0, verbatim, the test command narrowed per references/gates.md.
- `### Constraints` ends with the CLI's three closing constraints, always:
<!-- generated: closing-constraints -->
  - Do NOT invent new functions not described in the task
  - Do NOT add features not described in the task
  - Do NOT import packages not listed in the project dependencies
<!-- /generated -->
  plus the skill's own: `Do NOT run git add, git commit, git stash, or create .bak files`
- Rules found in the project's instruction files (CLAUDE.md, AGENTS.md, …) are copied into `### Constraints` verbatim; a never-commit rule goes into every brief.
- A `### Read-only context (do not modify) — <path>` section carries the whole context file when it is ≤ 300 lines; otherwise only the functions the brief reads, with a line `(excerpt: lines 40–95 of 412)`.

## Files written

    <run dir>/briefs/index.md      | id | title | file | action | depends_on |
    <run dir>/briefs/T001.md       one brief per outcome, dependency order

`index.md` is the table a human or `splitbrief-run` reads to know the order; it carries no other content.
