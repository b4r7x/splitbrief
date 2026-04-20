# Decisions — Workflow Modes Redesign

One ADR per non-obvious decision. Each records alternatives considered and why we rejected them. ADRs are immutable; if we change our mind later, we add a new ADR that supersedes the old one.

## ADR-001 — Rename `full` → `speckit`, add `instant`, keep `quick` and `standard`

**Status:** accepted
**Date:** 2026-04-20

### Context

Today the mode axis is `quick | standard | full`. In the design conversation the owner signalled two problems:

1. `full` is a watered-down sibling of `standard`. Their only difference is one extra approval gate. This is not worth a separate mode.
2. Real world demand for "just do the thing" (lighter than `quick`) and "team handoff / compliance" (heavier than `full`) exists.

### Decision

Four modes — `instant`, `quick`, `standard`, `speckit`. Rename `full` → `speckit`. Add `instant`. Keep `quick` and `standard` as-is.

### Alternatives

- **A) Only rename `full` → `speckit`. Do not add `instant`.** Rejected — leaves the trivial-change gap open. Users would keep using `quick` for tasks where even `tasks.md` is ceremony, and we cannot differentiate these runs in session history.
- **B) Keep `full` as a third "heavy" mode. Add `instant` + `speckit` → five modes.** Rejected — too many choices. Users already struggle to pick between `standard` and `full`.
- **C) Collapse `quick` and `instant` into one "light" mode with a flag.** Rejected — the mental model difference matters (§4.1.1 vs §4.1.2 of `spec.md`). "Show me tasks before you do anything" and "just do it" are different contracts.
- **D) No mode presets, everything as flags.** Rejected — dominates simple use cases with flag-verbosity. The preset captures "common bundles of flags" which is the actual user experience.

### Consequences

- Existing YAML configs with `workflow.mode: full` keep working via silent migration to `speckit`. The CLI `--mode full` flag continues to parse (alias → `speckit`) with a one-time deprecation warning. See `migration.md`.
- `quick` is the default for "I am not sure what to pick" because it has the safest failure mode (tasks visible before anything runs, easy to abort).
- `standard` remains the literal default in `DEFAULT_WORKFLOW_MODE` (unchanged behaviour for existing users).

---

## ADR-002 — `instant` lives under `diptych start --mode instant`, NOT a new `diptych do` command

**Status:** accepted
**Date:** 2026-04-20

### Context

During the design conversation the option of a `diptych do "..."` subcommand was raised. It would be more ergonomic for one-shot trivial tasks (`gh pr create` vs. `gh`).

### Decision

Keep `instant` under `diptych start --mode instant "..."`. Do not add a new subcommand.

### Alternatives

- **A) New `diptych do "..."` subcommand.** Rejected — duplicates entry points. The argument parsing, store initialisation, session-folder creation, and config loading are identical to `start`; the subcommand would be 30 lines of boilerplate plus `--mode instant` under the hood.
- **B) Alias: `diptych do` → `diptych start --mode instant`.** Rejected — still adds a second entry point to document and maintain. The ergonomic saving (`start --mode instant` → `do`) is 20 characters; alias doesn't carry its own weight.

### Consequences

- Users who want ergonomic one-liners can set a shell alias: `alias dd='diptych start --mode instant'`.
- Help output remains focused on one `start` command with clear flags.

---

## ADR-003 — Approval gates are orthogonal to mode

**Status:** accepted
**Date:** 2026-04-20

### Context

Today, mode implicitly decides which gates are active:

- `quick` → none
- `standard` → spec only
- `full` → spec + plan

Users who want "standard planner work but no interruptions" have to edit `workflow.autoApproveSpec: true` in YAML between runs. Unergonomic.

### Decision

Introduce `--approve <spec|plan|none|all>` CLI flag and `workflow.approve` config key. Default is `'default'` which falls back to the mode default table (§4.2). Mode-default table preserves the current behaviour for all four modes.

### Alternatives

- **A) Keep mode-implicit gates, add per-gate flags `--approve-spec` / `--approve-plan`.** Rejected — two flags when one enum would do. Also doesn't match the mental model "I want no gates" (would require both flags).
- **B) Single boolean `--no-gates`.** Rejected — cannot express "spec gate only" or "plan gate only", which are real cases (spec gate is the common "review before writing code" affordance; plan gate alone is useful when you trust the spec template but want to see the task breakdown).
- **C) Leave today's `workflow.autoApproveSpec` / `workflow.autoApprovePlan` booleans as-is.** Rejected — two independent booleans is the worst ergonomics of the three. You have to toggle both to get "no gates". And the CLI has no one-shot override.

### Consequences

- Deprecate `workflow.autoApproveSpec` / `workflow.autoApprovePlan`. Migration logic translates: both true → `approve: 'none'`; only spec true → `approve: 'plan'`; etc. See `migration.md`.
- `--auto` remains as a legacy alias for `--approve none` so existing scripts keep working.
- Mode-default table is in `spec.md` §4.2. Lookup is one function (`resolveApproveLevel(mode, approve)`), shared by CLI and runtime.

---

## ADR-004 — `speckit` adds three real phases, not just ceremony

**Status:** accepted
**Date:** 2026-04-20

### Context

If `speckit` is just `standard + 1 extra gate`, it is indistinguishable from today's `full`. The user request was "spec-kit-like" — implying the constitutional check, clarification Q&A, and cross-artifact analysis that `github/spec-kit` and `gotalab/cc-sdd` ship.

### Decision

`speckit` adds three new phases in this order: `clarifying` → `constitution-check` → (plan) → `analyzing`. Each is a separate planner call, separate state transition, separate artifact.

### Alternatives

- **A) Collapse all three into one "formalize" phase.** Rejected — each produces a distinct artifact (`clarifications.md`, `constitution-check.json`, `analyze.json`) that a downstream tool might consume independently. Also loses the option to fast-fail on constitution-check before spending tokens on planning.
- **B) Only add constitution-check, skip clarifying and analyzing.** Rejected — partial answer. Teams that care about constitutional compliance also care about requirement completeness (clarifying) and traceability (analyzing).
- **C) Make the three phases optional flags (`--constitution`, `--clarify`, `--analyze`).** Rejected — then `speckit` mode is just a macro for "all three on" and the user can achieve the same thing on `standard` with three flags. This is possible but confusing. Better: `speckit` is the preset; individual phases are not independently togglable in v1. Can reconsider if user demand appears.
- **D) Put the analyze phase after `implementing`, not after `planning`.** Rejected — the value of analyze is *before* code is written (catch gaps, re-plan if coverage too low). Post-implementation analysis is a separate use case.

### Consequences

- `speckit` is 2–3 more planner calls than `standard`. This is expected — speckit is for team/compliance work where tokens are not the bottleneck.
- If `.specify/memory/constitution.md` is absent, `constitution-check` is a no-op (passes silently). Projects that adopt speckit without a constitution still get value from clarify + analyze.
- `CONSTITUTION_CHECK_FAIL` ends the workflow. We assume a failing constitution check means the feature itself is wrong and needs to go back to the user. This is stricter than a warning; it is *the* feature of speckit.

---

## ADR-005 — Local heuristic for mode-downgrade warning; never an LLM call

**Status:** accepted
**Date:** 2026-04-20

### Context

The design conversation's explicit direction: the downgrade advisor must not spend user tokens. An LLM classifier is therefore off the table.

### Decision

Local regex + word-count heuristic. Emits an advisory toast. Never blocks. No LLM involvement.

### Alternatives

- **A) LLM classifier.** Rejected in conversation (Q3 answer).
- **B) No advisor at all.** Considered — would be simpler and has zero false-positive risk. But the design conversation named this as a pain point. Shipping nothing here would ignore a stated concern.
- **C) Advisor runs after planner call, on the planner's first response.** Rejected — by the time the planner is writing, the downgrade decision is moot. Advisor must run before any planner call.

### Consequences

- False positives (advising downgrade when the user really did want `standard`) are possible and expected. Tuning is trivial (edit keyword list) and the advisory is only a toast, not a block.
- We commit to not adding LLM-based advising even if we add more sophisticated local heuristics later. If demand for smart advising appears, it becomes a separate spec.

---

## ADR-006 — `PlannerCapabilities` grows `supportsEffort` and `supportsImages`; does not become a dict

**Status:** accepted
**Date:** 2026-04-20

### Context

Today `PlannerCapabilities` is a flat struct of booleans (3 fields). This redesign wants to add two more. A reasonable alternative would be to migrate to a string-keyed dict (`capabilities: Record<string, boolean>`) to avoid ongoing schema changes.

### Decision

Stay with the flat struct. Add `supportsEffort: boolean` and `supportsImages: boolean` as two new named fields.

### Alternatives

- **A) `capabilities: Record<Capability, boolean>`** with `type Capability = 'conversationalPlanning' | 'hintEscalation' | ...`. Equivalent at runtime, worse at type-time (no exhaustiveness check on switch/if), worse for discoverability (autocomplete on field name).
- **B) `capabilities: string[]` where absence = false.** Rejected — drops the "we know this backend does not support X" signal. Absence and "known-not-supported" are different states for diagnostics.

### Consequences

- `agent-sdk.ts`, `claude-code.ts`, `cli.ts`, `api.ts`, and `command-invoke.ts` all grow two fields in their capability declaration. One-line change each.
- `src/core/schemas/planner-config.ts` (capability override for `shell`/`agent` kinds) gains optional entries for the new fields.
- Future capability additions will require the same pattern. Acceptable — new capabilities happen rarely (every few months) and each one genuinely deserves a named, typed field.

---

## ADR-007 — Image drag-drop detection is a dumb regex, not bracketed-paste parsing

**Status:** accepted
**Date:** 2026-04-20

### Context

Terminal drag-drop behaviour differs per emulator. iTerm2 puts the dropped file's path on stdin. Warp does the same. Kitty uses a custom escape sequence (`\x1b]52;...`). Ghostty is similar to iTerm2. WezTerm has a config option (off by default).

### Decision

Detect image attachments by a regex on the incoming input buffer: `/^\S*\.(jpe?g|png|gif|webp|bmp)(\s|$)/i`, combined with a filesystem check that the path exists. No terminal-protocol parsing.

### Alternatives

- **A) Full bracketed-paste protocol + per-emulator file-drop escape parsing.** Rejected — ink 6 does not expose bracketed-paste markers, and Kitty's image protocol is a rabbit hole. Effort-to-value is poor.
- **B) Only support `/attach <path>`, no drag-drop.** Considered — minimal, unambiguous. Rejected because the design conversation explicitly named drag-drop as a desirable UX.
- **C) Use a separate text input mode for attachments (`Ctrl-I` then path).** Rejected — adds a keybinding and a mode, worse than the two-approach combo of drag-drop + slash command.

### Consequences

- Drag-drop "works" on iTerm2, Warp, Ghostty. Does not work on Kitty (needs custom protocol) or anything that doesn't emit the path as plain text. Documentation notes the limitation; users on unsupported terminals use `/attach`.
- False positives (user pastes a path-looking string they did not intend as an attachment) are mitigated by: only matching when the entire input is a single token matching the regex; file-exists check; and showing a visual attachment chip with an `x` to remove.

---

## ADR-008 — Effort control maps to model-specific parameters; unsupported backends are a no-op with a log event

**Status:** accepted
**Date:** 2026-04-20

### Context

Not every planner backend supports controlling reasoning effort. Claude Code CLI does via `/effort` (slash command). Codex CLI does via `--reasoning-effort`. OpenAI API does via `reasoning_effort`. Anthropic API does via `thinking`. Local models (Ollama, LM Studio) generally do not. Shell/agent backends are user-configured.

### Decision

Unsupported = no-op. Log a single `planner_effort_unsupported` event per run. Do not fail. Do not warn the user repeatedly.

### Alternatives

- **A) Refuse to start if `--planner-effort` is given but backend does not support it.** Rejected — punishes users for setting a default in YAML and then using a different backend. Effort should be a soft preference.
- **B) Loud warning on every planner call when unsupported.** Rejected — noisy.
- **C) Silently drop without logging.** Rejected — makes diagnostics harder ("why is effort not affecting anything?").

### Consequences

- `planner_effort_unsupported` is emitted to `session.jsonl`, `stdoutJsonSink`, and OTel. Easy to grep.
- If Claude Code later adds `--effort` as a real CLI flag, we switch from prompt-prefix injection to argv. Minimal change.

---

## ADR-009 — `git.createBranch` prefix is hardcoded to `diptych/`; not user-configurable

**Status:** accepted
**Date:** 2026-04-20

### Context

Users who opt into `createBranch: true` want diptych to create a feature branch for them. We could make the prefix configurable (`diptych/`, `feat/`, nothing, etc.).

### Decision

Hardcode `diptych/`.

### Alternatives

- **A) Configurable prefix (`git.branchPrefix`).** Rejected — YAGNI. Single user request to date. If more users want custom prefixes, add in v2.
- **B) No prefix (just the feature slug).** Rejected — then an accidental collision with an existing branch named like the feature is possible. The `diptych/` prefix also makes it trivially visible which branches were created by diptych.

### Consequences

- Branch naming is `diptych/<slug>` where slug is `kebab-case(feature)` (lowercase, non-alphanumeric → `-`, collapsed), with `-N` suffix on collision. Slug is shared with the existing session-id format (`.diptych/sessions/<date>-<slug>`).
- Projects that have strict branch naming conventions won't use this feature in v1; they can still use `commitStrategy: per-task` on their own branch.

---

## ADR-010 — Task contract is documented but not versioned

**Status:** accepted
**Date:** 2026-04-20

### Context

External tools (Kanban viewer, Jira sync, export scripts) will read `state.json` for tasks. A stable contract matters. Do we version it?

### Decision

Document the contract in `docs/TASK-CONTRACT.md`. Do not add a version field to `state.json` dedicated to the task schema. Reuse the existing `state.stateVersion` — if we break task shape, we bump that.

### Alternatives

- **A) Separate `taskSchemaVersion` field.** Rejected — adds surface area for a theoretical future problem. Breaking task shape is rare and would justify a `stateVersion` bump regardless.
- **B) JSON Schema file (`schemas/task.schema.json`) for external validation.** Considered — useful for tool authors. Defer to v2 unless an external tool asks for it. In v1, TypeScript types + doc prose are enough.

### Consequences

- External tool authors read the markdown doc. If they break on a shape change, they check the changelog (which already documents `stateVersion` changes).
- If an external tool becomes popular, we can add a JSON Schema file without breaking the contract.
