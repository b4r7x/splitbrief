# Implementation Prompt

Copy the prompt below into a fresh Claude Code session. Replace `{SPEC_FOLDER}` with the spec folder name (e.g. `2026-04-30-yolo-mode`).

---

```
Implement the spec at `docs/superpowers/specs/2026-04-30-real-e2e-tests/spec.md`.

## How to work

1. **You are the coordinator.** Read the full spec first to understand scope, then break it into independent chunks and dispatch subagents to implement them in parallel. Keep your main context clean — don't do the file edits yourself.
2. **Each subagent** gets: the specific files to read and modify, the exact code from the spec, and the conventions below. Subagents must read every file before modifying it.
3. **After subagents finish**, you verify:
   - Run `npm run format` to fix formatting
   - Run `npm run test-ci` (typecheck + lint + test) — must pass with zero failures
   - If anything fails, diagnose and fix in a loop until green
4. **Report** what was implemented, files changed, and test-ci result.

## Subagent dispatch rules

- Group changes by independence: schema changes can parallel with test files, but files that import each other must be sequential
- Each subagent prompt must include:
  - Exact file paths to read and modify
  - The code snippets from the spec for those files
  - The conventions list below
- Use `isolation: "worktree"` only if the spec says so — otherwise subagents work on the same tree sequentially or on non-overlapping files in parallel

## Critical rules

- **NEVER `git add`, `git commit`, `git stage`** — a hook blocks it. Leave everything unstaged.
- **Read before writing** — always read a file before modifying it.
- **Surgical edits** — edit specific sections, don't rewrite whole files.

## Conventions (pass to every subagent)

- ESM only — `.js` extension in every import (`'./config.js'` not `'./config'`)
- Zero classes — pure functions, module-scoped state
- Zero barrels — no `index.ts` anywhere in `src/` or `testing/`
- Zero memoization — no `useMemo`, `useCallback`, `React.memo`
- Zero decorative comments — no banners, no narration
- kebab-case file and folder names
- Zod 4.x for schemas
- Colocated tests — `foo.test.ts` next to `foo.ts`
- Behavior-only tests — assert observable state, not internal calls. No `vi.mock('./sibling')`, no `vi.spyOn` on internals
- No `!` or broad `as` in production code

## Key docs (read if spec doesn't provide enough context)

- `CLAUDE.md` — project rules
- `docs/TESTING.md` — test strategy, forbidden patterns
- `docs/ARCHITECTURE.md` — layer boundaries
- `docs/STRUCTURE.md` — file placement
- `docs/PRINCIPLES.md` — 20 rules

Implement exactly what the spec says. Nothing more, nothing less.
```

---

## Spec folders (implementation order)

| Order | Folder | What |
|---|---|---|
| 1 | `2026-04-30-yolo-mode` | `--yolo` CLI flag + `/yolo` slash command |
| 2 | `2026-04-30-approval-allowed-paths` | `approval.allowedPaths` config field |
| 3 | `2026-04-30-eval-harness` | Eval benchmark harness |
| 4 | `2026-04-30-real-e2e-tests` | VCR cassette e2e tests |
| 5 | `2026-04-30-mcp-write-tools` | MCP tools (agent → diptych feedback) |
| 6 | `2026-04-30-react-sota-audit` | No changes needed — audit clean |
