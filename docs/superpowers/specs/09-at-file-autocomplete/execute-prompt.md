# Execute Prompt: `@` File Path Autocomplete

## Prompt To Paste

```text
You are implementing @ file path autocomplete for diptych:

docs/superpowers/specs/09-at-file-autocomplete/

Goal:
Add mid-text @ file path autocomplete to the TUI input bar. When user types @ after a space or at line start, show a fuzzy-filtered dropdown of project files. Reuses fzf for fuzzy matching. File list from git ls-files (tracked + untracked, respects .gitignore) with filesystem fallback for non-git projects. Hardcoded security exclusions for .env, *.pem, *.key, credentials.*.

Hard repository rules:
- Do NOT run git add, git stage, git commit, or git stash.
- Verify with: npm run test-ci

Project constraints:
- Node.js 22+, TypeScript 6.x, ESM only (.js in all imports).
- No classes. No barrel files. kebab-case.
- Zod 4.x, Vitest 4.x, Biome 2.x.
- No useMemo, useCallback, React.memo.

Required skills to load BEFORE writing any code:
1. /sota
2. /test-behavior-not-implementation
3. /clean-code
4. /coding-standards

Required reading:
1. CLAUDE.md
2. docs/PRINCIPLES.md
3. docs/ARCHITECTURE.md
4. src/components/input-bar/use-slash-autocomplete.ts (existing slash hook — do NOT modify)
5. src/components/input-bar/input-bar.tsx (integration point)
6. src/components/input-bar/slash-suggestions.tsx (UI pattern to follow)
7. src/components/pickers/picker-utils.ts (computeScrollOffset, filterByFields)
8. src/core/slash-commands/fuzzy.ts (fzf usage pattern)
9. src/cli/parse-at-files.ts (existing @file CLI parsing — do NOT modify)
10. src/core/attachments/resolve.ts (attachment resolution)

Implementation: docs/superpowers/specs/09-at-file-autocomplete/agent-briefs/01-at-file-hook-and-ui.md

After done: npm run test-ci + verify @ suggestions appear when typing @src/ in input bar.
```
