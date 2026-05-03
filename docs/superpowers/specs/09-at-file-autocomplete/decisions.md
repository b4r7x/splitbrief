# Decisions

## ADR-001 — Separate Hook, Not Extension of Slash Autocomplete

**Status:** accepted

### Context

The existing `use-slash-autocomplete.ts` triggers on `/` at line start. `@` file completion triggers mid-text after a space. These are fundamentally different input modes — different trigger detection, different data source, different lifecycle.

### Decision

Create `use-at-file-autocomplete.ts` as a new hook. Do not modify `use-slash-autocomplete.ts`. Both hooks compose in `input-bar.tsx` — when one is active, the other is dormant.

### Consequences

- Slash autocomplete remains untouched — zero regression risk.
- Each hook owns its own state (filtered list, selected index, show/hide).
- `input-bar.tsx` coordinates which dropdown to render based on which hook is active.

## ADR-002 — File Listing via `git ls-files` With Filesystem Fallback

**Status:** accepted

### Context

Need to list project files for autocomplete. Options: (a) `readdir` recursive, (b) `git ls-files`, (c) `fd`/`find`. Claude Code and similar tools use filesystem-based listing respecting `.gitignore`.

### Decision

Primary: `git ls-files --cached --others --exclude-standard` — gives tracked + untracked files, minus `.gitignore`'d paths. Covers 95% of projects. Fallback: recursive `readdir` with `.gitignore` pattern filtering for non-git repos. Cache the file list per session (invalidate on `/refresh`).

### Consequences

- Untracked new files appear in suggestions (unlike `git ls-files` without `--others`).
- `.gitignore`'d files (node_modules, dist, .env) excluded automatically.
- Non-git projects still work via fallback.
- File list is cached — not re-scanned on every keystroke.

## ADR-003 — Hardcoded ALWAYS_EXCLUDE for Sensitive Files

**Status:** accepted

### Context

Even if `.gitignore` is missing or incomplete, sensitive files should never appear in autocomplete suggestions.

### Decision

Hardcoded exclusion patterns applied after git/filesystem listing:

```
.env, .env.*, *.pem, *.key, *.p12, *.pfx,
credentials.*, *secret*, .diptych/sessions/
```

These are filtered client-side after listing. Not configurable — security defaults should not be opt-out.

### Consequences

- Sensitive files never appear regardless of `.gitignore` state.
- Pattern list is small and static — no performance concern.
- Users who need to reference these files can still use `/attach` or type the path manually.

## ADR-004 — Trigger: `@` After Space or at Line Start

**Status:** accepted

### Context

Need to decide when `@` activates file completion vs being a regular character.

### Decision

Activate when `@` appears:
- At position 0 (start of input), OR
- Immediately after a space character.

Do not activate when `@` appears mid-word (e.g., `email@domain`).

### Consequences

- `@src/` at line start → triggers (attaching a file).
- `add auth @src/middleware.ts` → triggers (file reference mid-prompt).
- `user@email.com` → does NOT trigger (mid-word `@`).

## ADR-005 — Fuzzy Matching via Existing `fzf` Dependency

**Status:** accepted

### Context

As user types after `@`, need to filter the file list. Exact prefix matching is fragile (`@mdlware` won't find `middleware.ts`).

### Decision

Use the `fzf` library already in `package.json` for fuzzy matching, same as slash commands use via `src/core/slash-commands/fuzzy.ts`.

### Consequences

- Consistent ranking behavior with slash command autocomplete (AD-4 from DIRECTION.md: one fuzzy algorithm everywhere).
- No new dependencies.
