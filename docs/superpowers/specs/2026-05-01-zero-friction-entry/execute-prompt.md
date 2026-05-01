# Execute Prompt: Zero-Friction Entry

Use this prompt to hand the full spec pack to a fresh implementation context.

## Recommended Model

- Use `GPT-5.5`, reasoning `xhigh`, for the coordinator.
- Use `GPT-5.5` subagents for worker briefs.

## Prompt To Paste

```text
You are implementing the Zero-Friction Entry spec pack for diptych:

docs/superpowers/specs/2026-05-01-zero-friction-entry/

Goal:
Implement three CLI ergonomics improvements: (1) bare positional shorthand so `diptych "feature"` works as `diptych start "feature"`, (2) @file syntax to enrich planner context from the shell, and (3) help output with 10+ real examples. Treat this as SOTA production work: minimal surface, behavior-focused tests, no defensive over-engineering.

Hard repository rules:
- Do not run git add, git stage, git commit, or git stash.
- Do not revert user changes.
- Same-checkout implementation work must be sequential.
- If using subagents, writer subagents must not write in parallel in the same checkout.
- Parallel implementation is allowed only in isolated worktrees/equivalent sandboxes.
- Read-only audit subagents may run in parallel.

Project constraints:
- Node.js 22+, TypeScript 6.x, ESM only.
- Every local TypeScript import uses a .js suffix.
- No classes.
- No barrel files; do not create index.ts.
- No useMemo, useCallback, React.memo, forwardRef, or imperative handles.
- Prefer existing stores/selectors over Context bloat.
- Tests must verify behavior, artifacts, rendered output, public state, or filesystem effects.
- Do not add trivial hook tests.
- kebab-case file and folder names.
- Zero decorative comments or section banners.

Required reading, in order:
1. CLAUDE.md
2. docs/ARCHITECTURE.md
3. docs/STRUCTURE.md
4. docs/superpowers/specs/2026-05-01-zero-friction-entry/README.md
5. docs/superpowers/specs/2026-05-01-zero-friction-entry/decisions.md
6. src/cli.ts (main CLI entry point with Commander setup)
7. src/cli/commands/start.ts (start command registration and action)
8. src/cli/options.ts (workflow option builder)
9. src/core/schemas/attachment.ts (image attachment schema)
10. src/core/attachments/resolve.ts (attachment resolver)
11. src/stores/workflow/attachments.ts (attachment store)
12. src/engine/planners/types.ts (PlannerCallbacks.attachments)

Likely source files to inspect before editing:
- src/cli.ts
- src/cli/commands/start.ts
- src/cli/commands/start.test.ts
- src/cli/options.ts
- src/core/attachments/resolve.ts
- src/stores/workflow/attachments.ts

Implementation order:
1. Implement agent-briefs/01-cli-shorthand.md — one-line change + tests.
2. Implement agent-briefs/02-at-file-syntax.md — parser module, start.ts integration, tests.
3. Implement agent-briefs/03-help-examples.md — static help text, snapshot test.

Order rationale: Brief 01 is a prerequisite for Brief 02 (the @file syntax runs inside start's action handler which must be reachable via shorthand). Brief 03 is independent but documents the features from 01 and 02, so it comes last.

Important product decisions:
- Commander's { isDefault: true } routes unrecognized positionals to start. Explicit subcommands still take priority.
- @file text content is inlined into the feature prompt; images go through existing attachmentsStore.
- No changes to AttachmentKindSchema or planner protocol.
- Help examples are static strings using program.addHelpText('after', ...).
- Feature strings must be quoted in the shell.

Safe validation rules:
- Use fixture/stubbed/no-real-model validation.
- No real credentials.
- No network.
- No token spend.
- No writes to the user's checkout.

Required SOTA loop:
1. Implement one bounded brief with a subagent.
2. Run targeted validation for that slice.
3. Run read-only audit subagent for correctness, test quality, and convention compliance.
4. Fix blocker findings with bounded worker or small coordinator patch.
5. Repeat until PASS before moving to the next brief.

Required validation before final handoff:
- npm run typecheck
- npm run lint
- npm test

If npm test is skipped, state the exact reason and list targeted tests that passed.

Final report must include:
- files changed,
- tests run and results,
- skipped validation and reason,
- risks or follow-up work,
- final audit result,
- confirmation that no git add, git stage, git commit, or git stash was run,
- confirmation that no same-checkout parallel writes were used.
```
