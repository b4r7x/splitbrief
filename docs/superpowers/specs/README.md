# Execution Specs

11 speckit packs for upgrading diptych to polyglot, RPC-capable, production SOTA.

> **For agentic workers:** Each spec has an `execute-prompt.md` with a ready-to-paste prompt. The prompt tells the agent which skills to load, what to read, and which agent-briefs to implement.

## Execution Order

```
Phase 1 (parallel — no dependencies):
  01-polyglot-validation/       3 briefs, sequential
  02-polyglot-codebase-analysis/ 2 briefs, sequential
  04-rpc-mode/                   2 briefs, sequential
  05-transcript-compaction/      1 brief
  06-module-hooks/               1 brief
  08-lazy-provider-loading/      1 brief

Phase 2 (after Phase 1):
  03-polyglot-prompts/           1 brief ← depends on 01 (state.discoveredValidation.language)
  07-implementer-pool/           1 brief ← benefits from 01 (validation works with any profile)

Phase 3 (parallel — no dependencies on Phase 1/2):
  09-at-file-autocomplete/       1 brief
  10-html-session-export/        2 briefs, sequential
  11-structured-compaction/      1 brief ← depends on 05 (extends existing compaction)
```

## How to Execute

1. Open a fresh agent context
2. Paste the content of `execute-prompt.md` for the target spec
3. The agent reads required files, loads required skills, then implements agent-briefs in order
4. After completion, run `npm run test-ci` as final gate

## How to Review (SOTA Check)

After each spec, load these skills for review:
- `/sota` — state-of-the-art verification
- `/code-audit` — DRY, SRP, error handling, anti-slop
- `/test-behavior-not-implementation` — test quality
- `/clean-code` — no overengineering
- `/coding-standards` — conventions

Checklist:
- [ ] Tests assert behavior, not implementation details
- [ ] No overengineering — minimal abstractions
- [ ] Graceful degradation — missing/optional things skip, never error
- [ ] Backward compat — default TS project works identically
- [ ] Conventions — ESM .js imports, kebab-case, zero classes, no comments, colocated tests
- [ ] Docs accurate — reflect what was actually implemented
- [ ] No scope creep — agent stuck to the brief

## Spec Summary

| # | Name | Briefs | Key Deliverable |
|---|------|--------|-----------------|
| 01 | Polyglot Validation | 3 | 4-layer validation: config > planner-discovered > heuristic > skip |
| 02 | Polyglot Codebase Analysis | 2 | Language registry, lazy grammar loading, multi-lang repo map |
| 03 | Polyglot Prompts | 1 | Language-aware prompts, remove TS framing |
| 04 | RPC Mode | 2 | Bidirectional NDJSON stdin/stdout, approval gates via commands |
| 05 | Transcript Compaction | 1 | /compact-transcript, summary entries, auto-compaction |
| 06 | Module Hooks | 1 | Auto-discovery from .diptych/hooks/, module polish |
| 07 | Implementer Pool | 1 | Unblock route-bigger-worker, profile switching |
| 08 | Lazy Provider Loading | 1 | Memoized dynamic imports in factory.ts |
| 09 | `@` File Autocomplete | 1 | Mid-text `@` file path autocomplete in TUI input bar |
| 10 | HTML Session Export | 2 | `diptych export` + `/export` → self-contained HTML report |
| 11 | Structured Compaction | 1 | Zod-validated structured summaries with incremental merge |

## Required Skills per Spec

Every spec requires: `/sota`, `/test-behavior-not-implementation`, `/clean-code`

Additional per-spec:
- 01, 02, 03, 04, 05, 07, 11: `/code-audit`
- 03: `/prompt-engineering`
- 04: `/api-patterns`
- 09: `/coding-standards`

## Post-Completion (manual)

After ALL specs are merged:
- Remove "Known limitations: TypeScript / JavaScript target projects only" from `CLAUDE.md`
- Update `docs/FUTURE.md` — mark all completed items
- Run `npm run test-ci` as final gate
