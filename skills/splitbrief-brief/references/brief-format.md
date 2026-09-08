# Brief Format — Product Task Brief v1

The brief is the contract between the planner (this session) and the implementer (a different tool with no access to this session). Lifted from the SPLITBRIEF CLI (`src/engine/spec/prompts/task-format-example.ts`, `src/engine/spec/prompts/tasks.ts`). One brief = one file = one implementer run.

## Template

<!-- generated: brief-template -->
    Frontmatter values are parsed literally. Never emit an alternation such as `create | modify` — choose one value:

    - `id` — unique brief id: `T001`, `T002`, ... in emission order.
    - `title` — one short line.
    - `action` — exactly `create` or `modify`.
    - `file` — one project-relative path (no leading `/`, no `..`).
    - `depends_on` — YAML list of brief ids this one must follow: `[]` when independent, `[T001, T002]` when it must run after both.

    Copy this shape and substitute real values:

    ---
    id: T001
    title: Short descriptive title
    action: create
    file: src/path/to/file.ts
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

    ### Current Code
    ```typescript
    // Relevant existing code for modify tasks
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
    **In bounds:**
    - Concrete change this brief is allowed to make
    **Out of bounds:**
    - Adjacent change the implementer must NOT make
    **Approved out of bounds:**
    - Intentional exception paths that tiered approval may allow

    ### Escalation
    - Stop and ask when the required behavior is ambiguous, when a dependency is missing, or when the brief conflicts with local code.

    ### Evidence
    - Reviewable proof the task completed (passing tests, typecheck, changed files, behavioral note).

    ### Constraints
    - ESM imports with .js extensions
    - Follow existing codebase patterns
<!-- /generated -->

The fenced examples are TypeScript. For Python, Go, Rust, or JavaScript use that language's fence and idioms — the CLI substitutes the Signature, Type Definitions, and Current Code examples per language.

## Brief Contract (required semantics)

<!-- generated: brief-contract -->
Every brief must cover these nine semantic sections, even when one is brief:

1. **Identity** — frontmatter `id`, `title`, `action`, `file`, `depends_on`.
2. **Intent** — `### Description`: what the change is and why it matters.
3. **Scope** — `### Scope` with `**In bounds:**`, `**Out of bounds:**`, and optional `**Approved out of bounds:**` bullet lists. REQUIRED in standard mode so the implementer cannot drift into adjacent files or features.
4. **Code Context** — `### Signature`, `### Current Code`, `### Type Definitions`, and `### Pattern`: copied verbatim from the project when relevant. The implementer cannot look up other files.
5. **Implementation Plan** — `### Implementation Steps`: 3-5 numbered steps with concrete function calls and patterns.
6. **Validation** — `### Tests`: REQUIRED concrete test cases with specific inputs and expected outputs, in every brief. No phrases like "should work correctly", and no deferring the cases to whichever brief owns the test file.
7. **Constraints** — `### Constraints`: invariants, dependency rules, ESM imports with .js extensions, refusal conditions.
8. **Escalation** — `### Escalation`: bullets describing when the implementer must stop and ask instead of guessing. Required whenever the brief contains plausible ambiguity.
9. **Evidence** — `### Evidence`: REQUIRED bullets describing the reviewable proof that should exist when the brief is done (passing tests, validation output, changed files, behavioral note).
<!-- /generated -->

## Critical Rules

<!-- generated: critical-rules -->
1. **Self-contained**: Each brief must inline ALL context needed. Include relevant current code for modify tasks, TypeScript type annotations, import paths, function signatures from dependencies, and expected patterns.

2. **Atomic**: One brief = one file. Either create a new file or modify an existing one. Never split a single file across briefs or combine multiple files in one brief.

3. **Dependency-ordered**: Briefs must be ordered so dependencies come first. Use `depends_on` to declare which briefs must complete first. Independent briefs can run in parallel.

4. **Concrete validation**: Every `### Tests` block must list specific test cases with concrete inputs and expected outputs, as `-` bullets. This holds for every brief, including one whose test file a different brief owns: list the cases that verify THIS brief's change. Never replace the bullets with prose that defers validation to another brief.

5. **Inline type definitions**: Copy referenced TypeScript type annotations or data shape definitions verbatim into `### Type Definitions`. Max ~300 tokens — prioritize definitions that appear in the function signature.

6. **Import paths**: Specify exact imports using ESM imports with .js extensions.

7. **Escalation, not guessing**: If a brief could be interpreted multiple ways, list those decision points under `### Escalation` rather than baking a guess into the steps.

8. **Evidence is not implementation**: `### Evidence` describes the proof that survives after the brief is done, not the steps that produce it.

9. **Reserved delimiter**: Outside fenced code blocks, lines containing only `---` are reserved for Task Brief frontmatter delimiters. Never use a bare `---` as a horizontal rule or phase-heading separator.
<!-- /generated -->

The three blocks above are generated from the CLI with its TypeScript language context (`npm run skills:sync`; `npm run skills:check` fails when they drift). Two readings differ in the skill: contract item 3's `REQUIRED in standard mode` is `always` here (Scope is required in both skill modes), and the TypeScript-specific wording (`TypeScript type annotations`, `ESM imports with .js extensions`) becomes the project language's own convention for other languages.

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
- `### Current Code` carries the whole file when it is ≤ 300 lines; otherwise only the enclosing functions the brief touches, with a line `(excerpt: lines 40–95 of 412)`.
- Brief cap: `quick` 5, `standard` 12. Above 12 → stop after writing the briefs and recommend splitting the task.

## Files written

    <run dir>/briefs/index.md      | id | title | file | action | depends_on |
    <run dir>/briefs/T001.md       one brief per file, dependency order

`index.md` is the table a human or `splitbrief-run` reads to know the order; it carries no other content.
