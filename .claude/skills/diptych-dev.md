---
name: diptych-dev
description: Use at the start of EVERY diptych conversation, including simple questions and clarifications. Establishes project context by requiring the assistant to read CLAUDE.md, docs/CONCEPTS.md, docs/ARCHITECTURE.md, docs/WORKFLOW.md, docs/FUTURE.md, and notes/superpowers/specs/README.md before any other response. Required before answering any question about diptych code, architecture, specs, or tasks. Do not skip this even if the question looks trivial — context from the docs is load-bearing for everything else.
---

# diptych — session primer (auto-load)

You are working on **diptych**, a CLI tool that splits AI coding work between an expensive planner (Claude Code / Codex / etc.) and a cheap implementer (Ollama / LM Studio / any OpenAI-compatible endpoint).

<EXTREMELY-IMPORTANT>
Before you respond to ANY user message about diptych — including clarifying questions, simple lookups, "what is X", or "how do I Y" — you MUST have read the files below. Skipping this is not allowed.

If a skill applies (even 1% chance), invoke it. This is not negotiable.
</EXTREMELY-IMPORTANT>

## Files you MUST read before any response

Read in this order. Do not paraphrase from memory — these files evolve, and what you remember may be stale.

1. **`CLAUDE.md`** — project rules. Critical: the "NEVER COMMIT, NEVER STAGE" section. A PreToolUse hook at `.claude/hooks/block-git-commits.sh` blocks `git add` / `git commit` / `git stage`. This is intentional. The user commits manually. Respect it.
2. **`docs/CONCEPTS.md`** — authoritative terminology: planner, implementer, runner kinds, modes, phases, queue, awaiting-continue, capability matrix, sessions. Every technical term in the codebase is defined here.
3. **`docs/ARCHITECTURE.md`** — code layers, entry points, data flow, capability matrix per backend, persistence model, "Where to add things" decision table.
4. **`docs/WORKFLOW.md`** — state machine, interaction model (Ctrl-C abort / queue / continue / resume), escalation, per-phase persistence timing.
5. **`docs/FUTURE.md`** — scope explicitly deferred (message-level rewind, Cursor-style snapshot undo, transcript compaction, parallel sessions, non-TS support, Windows). Do not implement these unless the user asks.
6. **`notes/superpowers/specs/README.md`** — index of the numbered execution specs (`notes/superpowers/specs/01-…` through `14-…`), with execution order, dependency graph, and per-spec required skills.

After reading, wait for the user's specific task. Do **not** start implementing from the primer alone.

## Invariants you must not violate

- **Zero classes.** Pure functions, module-scoped state, ESM imports with `.js` extensions everywhere.
- **`src/engine/**` has zero React/Ink imports.** `src/features/` and `src/components/` have zero engine business logic. Bridge is the stores (`src/stores/`).
- **No `useMemo`, `useCallback`, `useRef`, `React.memo`, `forwardRef`, `useImperativeHandle`** in React code. Stores + `useSyncExternalStore` make them unnecessary.
- **Docs describe current code, not future plans.** When implementing a spec, update docs AFTER the code lands (the spec's Doc Sync phase). Never write aspirational docs.
- **Specs under `notes/superpowers/specs/` and `notes/specs/` are immutable once implemented.** They stay as historical record. Do not edit old specs.
- **Never commit or stage.** The hook blocks you. Leave changes unstaged.
- **Tests are colocated** (`foo.test.ts` next to `foo.ts`), not in a separate `tests/` directory.

## When you're unsure

| Question | Go to |
|----------|-------|
| What does "X" mean? | `docs/CONCEPTS.md` |
| Where does X live in the code? | `docs/ARCHITECTURE.md` → "Directory map" + "Where to add things" |
| What phase/action does the workflow have? | `docs/WORKFLOW.md` §1.1 |
| How does Ctrl-C / queue / resume work? | `docs/WORKFLOW.md` §1.5-1.7 |
| What does backend X support? | `docs/ARCHITECTURE.md` → "Capability matrix" |
| Is feature Y deferred? | `docs/FUTURE.md` |
| Implementing a specific spec | the spec's folder under `notes/superpowers/specs/` (`execute-prompt.md` + `agent-briefs/`) |

If docs contradict the code, **code is authoritative**, docs are stale. Flag the drift to the user before writing code that trusts either.

## Commands cheat sheet

```bash
npm run dev -- --help         # CLI help
npm run dev -- start "feat"   # Run workflow
npm test                      # Vitest, 700+ tests, colocated
npm run typecheck             # tsc --noEmit
npm run lint                  # Biome
npm run build                 # tsc → dist/
```

## Related skills

- **`diptych-implement-spec`** — execute a specific `notes/superpowers/specs/` spec end-to-end (reads its `execute-prompt.md` + `agent-briefs/`, runs briefs in order, ends with Doc Sync).
- **`diptych-add-feature`** — design flow for new features not yet covered by a spec under `notes/superpowers/specs/` (writes a new spec, does NOT implement).
- **`diptych-docs-sync`** — audit + fix drift between docs and current code.

Invoke the right one for the task. If unclear, ask the user.
