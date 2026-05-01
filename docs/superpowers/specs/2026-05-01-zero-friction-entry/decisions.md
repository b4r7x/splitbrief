# Decisions

## ADR-001 - Use Commander's `isDefault: true` For Shorthand

**Status:** accepted
**Date:** 2026-05-01

### Context

Users want `diptych "feature"` to work like `diptych start "feature"`. Commander.js supports marking a subcommand as the default via `program.command('start [feature]', { isDefault: true })`. This routes unrecognized positional arguments to the default command while preserving explicit subcommand routing.

### Decision

Add `{ isDefault: true }` to the existing `start` command registration. Do not create a separate registration path or pre-parse argv.

### Consequences

- `diptych "feature description"` reaches the same action handler as `diptych start "feature description"`.
- Explicit subcommands (`diptych spec`, `diptych doctor`, `diptych status`) still match first -- Commander resolves registered commands before falling through to the default.
- No argv pre-processing or manual argument slicing needed.
- All existing `start` options (`--mode`, `--auto`, `--detach`, etc.) work in shorthand form.

## ADR-002 - Bifurcate @file By Extension: Text Inlined, Images Attached

**Status:** accepted
**Date:** 2026-05-01

### Context

The @file syntax accepts both text files (`.md`, `.txt`, `.ts`, etc.) and image files (`.png`, `.jpg`, etc.). The existing attachment pipeline (`resolveAttachment`, `attachmentsStore`, planner `attachments` callback) only handles images. The planner `plan()` signature already accepts `codebaseContext?: string` which is a natural seam for text injection.

### Decision

At parse time, bifurcate by file extension:

- **Image files** (extensions matching `SUPPORTED_IMAGE_EXTS`): route through `resolveAttachment` and `attachmentsStore.add()` -- the existing pipeline.
- **Text files** (everything else): read contents via `readFileSync`, concatenate with filename headers, and pass to the planner as additional user context prepended to the feature description.

### Consequences

- No changes to `AttachmentKindSchema` or the planner attachment protocol.
- Text context is visible to all planner backends regardless of image support.
- Image attachments degrade gracefully on backends without `supportsImages`.
- The text approach is simple concatenation -- no streaming, no chunking, no embedding.
- A 10 MB size limit applies to individual files (matching `MAX_ATTACHMENT_BYTES`).

## ADR-003 - @file Parsing Happens In The Start Action, Not In Commander Parsing

**Status:** accepted
**Date:** 2026-05-01

### Context

Commander parses `[feature]` as a single positional string. The @file tokens appear as additional positional arguments after the feature string. Commander would need `.arguments('<feature> [files...]')` or pre-processing to collect them.

### Decision

Use Commander's variadic arguments support: change `'start [feature]'` to `'start [feature] [files...]'` (or collect remaining args). Inside the action handler, scan the remaining positional arguments for `@`-prefixed tokens. Arguments starting with `@` are file references; others are concatenated into the feature string.

Alternatively, parse the combined argv remainder after Commander processes known options. The parser is a pure function in `src/cli/parse-at-files.ts` that returns `{ feature: string; filePaths: string[] }`.

### Consequences

- @file tokens are positional, not options -- no `--file` flag needed.
- The parser is independently testable.
- Feature descriptions with literal `@` at the start of a word need quoting or escaping (documented in help examples).
- The parser strips the leading `@` before resolving paths.

## ADR-004 - Help Examples Use Commander's `addHelpText('after', ...)` At Program Level

**Status:** accepted
**Date:** 2026-05-01

### Context

Commander supports `addHelpText('after', text)` to append custom content after the standard help output. Users expect `diptych --help` (top-level) to show common patterns.

### Decision

Add help text at the program level using `program.addHelpText('after', ...)`. Include 10+ real-world examples covering shorthand, @file, mode selection, provider overrides, worktrees, detach, and headless mode.

### Consequences

- Examples appear in `diptych --help` and `diptych help`.
- Subcommand-specific help (`diptych start --help`) can have its own focused examples.
- Examples are static strings in source -- no runtime generation.
- Both shorthand (`diptych "..."`) and explicit (`diptych start "..."`) forms appear in examples so users discover both.

## ADR-005 - Feature String Allows Multi-Word Without Quotes In Shell

**Status:** accepted
**Date:** 2026-05-01

### Context

Shell users typically quote multi-word arguments: `diptych "add auth flow"`. However, if someone writes `diptych add auth flow`, Commander will try to match `add` as a subcommand. With `isDefault: true`, unrecognized first words fall through to the default command.

### Decision

The feature positional captures exactly one shell argument (the quoted string). This matches existing `start` behavior. Do not implement multi-word concatenation of bare positional args -- that would conflict with Commander's subcommand resolution. Document quoting in help examples.

### Consequences

- `diptych "add auth flow"` works (single quoted argument).
- `diptych add auth flow` would try to match `add` as a subcommand, fail, fall through to default, and receive `add` as feature with `auth` and `flow` as potential @file args or extra positionals. This is confusing.
- Help examples always show quoted feature strings.
- The parser can gracefully handle accidental multi-word by concatenating non-@-prefixed positionals with spaces (fallback, not primary UX).
