# Decisions

## ADR-001 — Export Artifacts, Do Not Execute External Agents

**Status:** accepted

### Decision

Handoff Packs generate files and prompts. They do not launch Claude Code, Codex, OpenCode, Kilo, or Copilot.

### Rationale

Launching external agents would expand diptych into a multi-agent orchestration platform. The product moat is the compiled contract, not controlling every execution surface.

## ADR-002 — Target-Specific Prompts Share One Semantic Source

**Status:** accepted

### Decision

All target renderers consume the same session + Task Brief data and render different output formats.

### Rationale

This avoids prompt drift between tools. The target wording changes, but the contract does not.

## ADR-003 — Generated Files Live Inside Session Folder

**Status:** accepted

### Decision

Write handoff packs under `.diptych/sessions/<id>/handoffs/<target>/`.

### Rationale

Handoffs are artifacts of a diptych session. They should not pollute project root or agent-specific config unless the user moves them manually.

---

> The eight decisions below (ADR-004 through ADR-011) were added 2026-04-26 after a research sweep across SpecKit, Copilot Workspace, Claude Code, Codex, Cursor, Aider, OpenCode, Kilo, Cline, and the A2A/MCP/AGENTS.md ecosystem. They override the implicit "six target list" in `agent-briefs/01-handoff-renderers.md` and add explicit machine-readable structure. The implementing agent must read these before writing the spec.

## ADR-004 — Canonical Source-of-Truth Is a Spec-Kit-Shaped Folder

**Status:** accepted

### Decision

Each handoff pack is a folder structured as:

```
.diptych/sessions/<id>/handoffs/<target>/
├── manifest.json
├── spec.md            # narrative, optional, present if mode produced one
├── plan.md            # narrative, optional, present if mode produced one
├── constitution.md    # copied from project root if present
├── tasks/
│   ├── T001.md
│   ├── T002.md
│   └── …              # one self-contained Task Brief per file
└── README.md          # target-specific entry instructions
```

This shape is consumed natively by Spec Kit, Claude Code, Cursor, Windsurf, Gemini CLI, and Copilot. It is the de-facto interchange format in 2026 and adoption is accelerating (≈30 supported agents at time of writing).

Target-specific renderers wrap or reference this folder; they do not replace it. The `spec-kit` target is the identity renderer (folder-as-is). Other targets produce a thin `README.md` and optionally a single concatenated prompt that points back to the same files.

### Rationale

- Half-life of a hand-written prompt per target is short (every model release shifts what works). A structured folder outlives prompt fashion.
- Lets the user `cd` into the pack and run `claude`, `codex exec`, `opencode run`, or `cursor` against the same files — no per-tool conversion step.
- Gives `manifest.json` (ADR-005) a stable filesystem to anchor.
- Aligns diptych's internal Task Brief schema with the public Spec Kit schema, opening a future bridge in both directions.

### Rejected alternatives

- **One concatenated prompt per target.** What `agent-briefs/01-handoff-renderers.md` implies. Rejected: prompt drift between targets, painful to maintain, doesn't survive long sessions, no machine-readable index.
- **JSON-only pack, render markdown lazily.** Rejected: most coding agents want markdown they can `@file` reference; pure JSON adds a parse step without value.

## ADR-005 — Every Pack Includes a `manifest.json`

**Status:** accepted

### Decision

Every handoff pack includes `manifest.json` at the pack root. Schema (Zod-validated, written to `src/core/schemas/handoff-manifest.ts` when implemented):

```ts
{
  packVersion: "1",                    // schema version of this manifest
  diptychVersion: string,              // version of diptych that produced it
  generatedAt: string,                 // ISO 8601
  sessionId: string,                   // diptych session id
  briefHash: string,                   // sha256 of canonical task array (see ADR-008)
  sourceCommit?: string,               // git HEAD at time of generation, if in git repo
  target: string,                      // see note below — open string, not closed union
  mode: "instant" | "quick" | "standard" | "speckit",
  taskIds: string[],                   // ordered list of T0NN ids included in this pack
  artifacts: {
    spec?: "spec.md",
    plan?: "plan.md",
    constitution?: "constitution.md",
    tasks: string[]                    // relative paths to task files
  },
  validation: {
    typecheck?: string,                // command, e.g. "npm run typecheck"
    lint?: string,
    test?: string
  },
  notes?: string                       // free-form, optional
}
```

### Rationale

- A2A's `AgentCard` and Spec Kit directory layouts both prove the value of a machine-readable index alongside prose.
- Without a manifest, every external tool must parse markdown to know what's in the pack. With it, dispatch/validate/sync/resume are trivial scripts.
- `briefHash` enables external tools to detect stale packs.
- `sourceCommit` enables clean integration with stacked-PR / worktree workflows.
- `validation` makes "did the implementer's work pass?" a one-line script.

### Rejected alternatives

- **No manifest, infer from filenames.** Rejected: brittle, no version negotiation, no integrity check.
- **Embed manifest as YAML frontmatter in `spec.md`.** Rejected: not all targets render frontmatter the same way, harder for tooling to discover.

### Note on `target` field type — reconciled with ADR-010

`target` is typed as `z.string()` (open string), not a closed Zod literal union of the four built-in target names. Reason: ADR-010 allows custom renderers loaded from `.diptych/handoff-renderers/<name>.ts`, and a closed-union schema would reject any custom `<name>`. The four built-in target names (`spec-kit`, `agents-md`, `claude-code`, `copilot-issue`) are documented in JSDoc on the schema and enforced at the CLI/registry layer, not at the schema layer. This is the intentional resolution of an apparent conflict between ADR-005 (closed list) and ADR-010 (open extension); the spec-implementing agent must NOT re-litigate this — use `z.string()`.

## ADR-006 — Three Tiers of Targets, Plus `spec-kit` as Universal Default

**Status:** accepted

### Decision

Replace the six-target list in `agent-briefs/01-handoff-renderers.md` with four targets:

| Target | Covers | Output shape |
|---|---|---|
| `spec-kit` | Universal default. Cursor, Windsurf, Gemini CLI, Copilot CLI, anything with Spec Kit support. | The folder itself, no extra rendering. |
| `agents-md` | Codex CLI, OpenCode, Aider (via fallback), Kilo (via Cline fallback). | Adds `AGENTS.md` at pack root referencing tasks. |
| `claude-code` | Claude Code CLI + IDE. | Adds `CLAUDE.md`, `.claude/agents/`, optionally `.claude/skills/`. |
| `copilot-issue` | GitHub Copilot via `@copilot` issue/PR mention. | Renders single GitHub-issue-shaped markdown body, suitable for `gh issue create --body-file`. |

### Rationale

- These four cover every target in the original list (claude-code, codex, opencode, kilo, copilot, generic) without per-target prompt strings to maintain.
- `agents-md` is read as fallback by Codex, OpenCode, Aider, Kilo, and Gemini CLI — one renderer, four tools.
- `spec-kit` covers anything that natively understands the format, and acts as the "no-target-specified" default.
- Cuts maintenance surface roughly in half.

### Rejected alternatives

- **Six explicit targets** (claude-code, codex, opencode, kilo, copilot, generic) per the original brief. Rejected: high maintenance with low marginal coverage; codex/opencode/kilo all converge on AGENTS.md.
- **N targets via plugin only.** Rejected: too thin a default — most users want one of the four built-ins to "just work."

User-defined targets beyond the four are still supported via ADR-010.

## ADR-007 — CLI Shape `diptych handoff <target>` and `/handoff` Slash Command

**Status:** accepted

### Decision

Two surfaces, sharing one writer service:

**CLI:**
```
diptych handoff <target> [--session <id>] [--out <dir>] [--task <T001>[,T002,…]] [--mode default|append|overwrite]
```
- `<target>` defaults to `spec-kit`.
- `--session` defaults to the most recent session in the current project.
- `--out` defaults to `./handoff/<target>/` (project-relative, NOT under `.diptych/`).
- `--task` filters to a subset of tasks; default is all tasks of the session.
- `--mode default` errors if `--out` exists; `append` skips existing files; `overwrite` replaces.

**Slash command in TUI:**
```
/handoff <target> [task-id]
```
- Operates on the active session.
- Writes under `.diptych/sessions/<id>/handoffs/<target>/` (per ADR-003).
- Optional `task-id` exports a single task pack.

### Rationale

- CLI form is scriptable — fits CI pipelines and `gh issue create` chains.
- Slash form is fast — power users mid-session get a one-keystroke export.
- Two `--out` defaults (project-relative for CLI, session-folder for slash) reflect different intent: CLI is "I want to use this elsewhere," slash is "save with the session for later."
- `--mode` makes overwrite explicit; this matters because handoff packs may be edited by the user after export.

### Rejected alternatives

- **Single surface (CLI only or slash only).** Rejected: CLI is needed for CI; slash is needed for fast in-session export. Both are cheap.
- **Auto-write to project root by default.** Rejected: pollutes the repo; explicit `--out` is healthier.

## ADR-008 — `briefHash` Propagated Everywhere

**Status:** accepted

### Decision

Define `briefHash` as `sha256(canonicalJSON(tasks))` where `canonicalJSON` is deterministic key-ordered serialization of the validated `Task[]` for the session (excluding mutable fields like `status`).

`briefHash` is:
1. Stored in `manifest.json` (ADR-005).
2. Stored as YAML frontmatter in every `tasks/T0NN.md` in the pack.
3. Recorded per-entry in `evidence.json` (extending the spec #1 ledger).
4. Recorded in `drift-report.json` for forensic correlation.

When the brief is regenerated mid-run (re-plan, /redo, etc.), every downstream artifact written after that point carries the new hash. Evidence and drift entries with the old hash are kept verbatim — they reference what the implementer was told at the time, not what the brief later became.

### Rationale

- Without a stable hash, regenerating the brief silently invalidates evidence and drift correlation.
- External tooling (handoff consumers) can verify "I'm still operating on the brief I exported."
- Cheap: ~few hundred bytes of overhead per artifact.
- Required by ADR-005 (`manifest.briefHash`), so it must exist regardless.

### Rejected alternatives

- **Use git commit hash.** Rejected: brief regeneration doesn't always commit; ties brief identity to repo state which is wrong directionality.
- **Per-task hash only, no aggregate.** Rejected: handoff packs need one hash to identify the whole pack at a glance.

This decision creates a small NEW spec (`brief-hash-versioning`) that is a prerequisite for the handoff packs implementation. Handoff packs spec must declare this dependency explicitly.

## ADR-009 — Live Mode (MCP) Reserved as Tier 3 Roadmap, Not v1

**Status:** accepted

### Decision

v1 of handoff packs ships only the snapshot format described in ADR-004/005/006. A future v2 will expose the same data live via a read-only MCP server over `.diptych/sessions/<id>/`.

The pack format is forward-compatible: the MCP server will serve the same paths (`manifest.json`, `tasks/T0NN.md`, `spec.md`) as `mcp://diptych/session/<id>/...`. Pack consumers written for v1 will not break when v2 ships.

### Rationale

- A2A and MCP are converging on "agents read shared resources, not copied prompts." Diptych must not paint itself into a snapshot-only corner.
- v1 snapshot is independently useful and ships fast.
- Reserving the namespace now (in this ADR) prevents incompatible naming in v2.
- MCP server is its own engineering surface (auth, lifecycle, schema versioning) — premature for v1.

### Rejected alternatives

- **Ship MCP in v1.** Rejected: doubles the spec scope and complexity, and MCP capability still varies wildly across consuming tools in 2026.
- **Decline MCP entirely.** Rejected: foregoes the strategic moat documented in the research sweep (Tier 3 priority).

## ADR-010 — Custom Renderers Via Project-Local Hooks

**Status:** accepted

### Decision

Users can define additional render targets by dropping files under `.diptych/handoff-renderers/<name>.ts` (or `.js`). Each file exports a function with signature:

```ts
type HandoffRenderer = (input: HandoffInput) => Promise<HandoffPack>
```

`HandoffInput` contains the validated session, tasks, mode, and config. `HandoffPack` is the same structure built-in renderers produce (manifest + files). Custom renderers can call built-in renderers via an exposed API to extend rather than replace.

The renderer is invoked when `<target>` matches the file's basename, e.g. `diptych handoff linear-ticket` → `.diptych/handoff-renderers/linear-ticket.ts`.

### Rationale

- Mirrors the existing hooks pattern in diptych (`docs/HOOKS-CONFIG.md`).
- Lets companies adapt diptych to internal tooling (Linear/Jira/internal CI) without forking.
- Keeps the four built-in targets focused on universal need; custom needs go to user code.
- Discoverable: `diptych handoff --list` will enumerate built-ins + custom.

### Rejected alternatives

- **Plugin npm package model.** Rejected: too heavy for the common case; project-local file is simpler and version-controlled with the repo.
- **Templates only (no code).** Rejected: real handoff transformations sometimes need logic (e.g. splitting tasks across multiple Linear sub-issues).

## ADR-011 — Constitutional: Handoff Packs Never Execute Anything

**Status:** accepted (constitutional weight)

### Decision

Handoff packs are inert artifacts. Diptych does not, in this feature or any future extension of it:
- Spawn external agents (claude, codex, opencode, gh, etc.).
- Auto-pickup work from a pack on resume.
- Watch a pack folder and react to its state.
- Push packs to remote services (GitHub Issues, Linear, Slack) directly.

Users initiate execution. Optional CI/automation lives in user-controlled scripts that consume the pack — never in diptych itself.

This ADR reaffirms ADR-001 with explicit constitutional weight: future contributors must treat any proposal that violates this as requiring a Constitution amendment, not just a feature decision.

### Rationale

- Prevents handoff packs from becoming a backdoor to multi-agent orchestration (the explicitly rejected path per `docs/VISION.md` and the Constitution).
- Keeps the security surface trivial: no outbound network, no subprocess spawning beyond what diptych already does for planner/implementer.
- Preserves the user's role as the responsible party for what gets executed where — a non-negotiable trust property.

### Rejected alternatives

- **`diptych handoff <target> --run` flag.** Rejected: would spawn external agent. Constitutionally forbidden.
- **Watch mode that re-exports on session change.** Rejected: edges into orchestration territory; users can script it themselves with `chokidar` or `entr` if they want.

---

## Required updates to other artifacts when this spec is implemented

- `agent-briefs/01-handoff-renderers.md` — rewrite to enumerate the four targets in ADR-006, drop the six-target list.
- `agent-briefs/02-handoff-cli.md` — rewrite to match ADR-007 CLI shape.
- `agent-briefs/03-handoff-slash-command.md` — rewrite to match ADR-007 slash shape.
- New brief: `agent-briefs/04-handoff-manifest-schema.md` covering ADR-005 + ADR-008.
- New brief: `agent-briefs/05-handoff-custom-renderers.md` covering ADR-010.
- `README.md` — update Change Set table to reflect new briefs; add prerequisite reference to the new `brief-hash-versioning` spec (ADR-008).
- New top-level spec to be written: `docs/superpowers/specs/2026-04-26-brief-hash-versioning/` — must land before this spec implements.
