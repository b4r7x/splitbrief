# diptych — Agent Guide

## CRITICAL — NEVER COMMIT, NEVER STAGE

Do **NOT** run `git commit`, `git add`, `git stage`, or any command that creates a commit or stages files. The user commits manually. A `PreToolUse` hook at `.claude/hooks/block-git-commits.sh` enforces this with exit code 2.

---

diptych is an open-source CLI that orchestrates expensive AI (planner) and cheap/local AI (implementer) to cut AI coding costs by 50%+.

## Tech Stack

- Node.js 22+ (see `package.json` `engines`)
- TypeScript 6.x, ESM only (`"type": "module"`)
- Ink 6.8 + React 19 (TUI)
- Vitest 4.x (57 colocated test files / 700 tests)
- Biome 2.x (linter + formatter)
- `@anthropic-ai/claude-agent-sdk` declared as optional peer

## Project Structure

See `CLAUDE.md` for the full source tree and architectural notes.

## Commands

- `npm run dev` — run CLI via `tsx`
- `npm run build` — compile to `dist/`
- `npm test` — Vitest unit tests
- `npm run test:watch` — Vitest in watch mode
- `npm run test:coverage` — coverage report (v8)
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — `biome check .`
- `npm run format` — `biome format --write .`

## Conventions

See `CLAUDE.md` "Code Conventions" and "State Management" sections for the full rules (zero classes, ESM `.js` import suffixes, zero memoization, no `forwardRef`, external stores over Context, etc.).

Last updated: 2026-04-08
