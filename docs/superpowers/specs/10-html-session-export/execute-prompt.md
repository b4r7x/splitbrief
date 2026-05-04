# Execute Prompt: HTML Session Export

## Prompt To Paste

```text
You are implementing HTML session export for diptych:

docs/superpowers/specs/10-html-session-export/

Goal:
Add a CLI command (diptych export) and slash command (/export) that generate a self-contained HTML report from a completed session. One file, inline CSS, zero JS, zero CDN. Reads existing session artifacts (summary.json, evidence.json, drift-report.json, brief-quality.json) — never recomputes. Missing optional artifacts degrade gracefully (section omitted).

Hard repository rules:
- Do NOT run git add, git stage, git commit, or git stash.
- Verify with: npm run test-ci

Project constraints:
- Node.js 22+, TypeScript 6.x, ESM only (.js in all imports).
- No classes. No barrel files. kebab-case.
- Zod 4.x, Vitest 4.x, Biome 2.x.

Required skills to load BEFORE writing any code:
1. /sota
2. /test-behavior-not-implementation
3. /clean-code
4. /coding-standards

Required reading:
1. CLAUDE.md
2. docs/ARCHITECTURE.md
3. src/core/schemas/summary.ts (Summary schema — 228 lines, key data source)
4. src/core/schemas/evidence.ts (EvidenceLedger schema)
5. src/core/sessions/io.ts (readSummaryFile, listSessions)
6. src/features/summary/screen.tsx (TUI summary screen — visual reference)
7. src/features/summary/components/ (hero-savings, cost-breakdown, task-table, evidence, phase-timing)
8. src/engine/handoff/renderers/shared.ts (existing markdown rendering pattern)
9. src/cli/commands/stats.ts (CLI command registration pattern)
10. src/core/slash-commands/catalog.ts (slash command registration)

Implementation order (sequential):
1. docs/superpowers/specs/10-html-session-export/agent-briefs/01-html-renderer.md
2. docs/superpowers/specs/10-html-session-export/agent-briefs/02-cli-and-slash-command.md

After done: npm run test-ci + verify diptych export produces valid HTML for a session with summary.json.
```
