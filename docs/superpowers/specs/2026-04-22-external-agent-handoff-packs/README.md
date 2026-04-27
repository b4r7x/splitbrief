# External Agent Handoff Packs — 2026-04-22

> **Status:** draft spec (revised 2026-04-26 per ADR-004 through ADR-011).
> **Scope:** export diptych Task Briefs into ready-to-run folder packs for Claude Code, Codex,
> OpenCode, Kilo, GitHub Copilot, and any tool that reads Spec Kit folders or AGENTS.md.
> **Out of scope:** executing those agents, managing remote workers, snapshots/worktrees,
> Task Brief quality internals.

## Purpose

Diptych compiles the contract once, then lets users carry that contract to the coding tool they
already trust. This is artifact export, not orchestration. Diptych does not become a multi-agent
manager.

## Prerequisites

- **Recommended before implementing:** `2026-04-22-task-brief-evidence-contract` — higher-quality
  Task Briefs produce better handoffs. The first renderer implementation can work with the current
  `Task` schema.
- **Required before implementing brief 04 (manifest schema):** `2026-04-26-brief-hash-versioning`
  — provides `computeBriefHash(tasks: Task[]): string`. Brief 04 is blocked until that spec lands.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Product overview (this file). |
| 2 | `decisions.md` | ADR-001 through ADR-011 — source of truth. Read fully before writing code. |
| 3 | `agent-briefs/00-coordinator.md` | Execution order, shared files, shared invariants. |
| 4 | `agent-briefs/01-handoff-renderers.md` | Pure target-specific renderers; defines shared types. |
| 5 | `agent-briefs/02-handoff-cli.md` | CLI command and shared writer service. |
| 6 | `agent-briefs/03-handoff-slash-command.md` | TUI slash command. |
| 7 | `agent-briefs/04-handoff-manifest-schema.md` | Zod schema for manifest.json; BLOCKED on brief-hash-versioning. |
| 8 | `agent-briefs/05-handoff-custom-renderers.md` | Project-local custom renderer loading. |

## Change Set

| # | Brief | Goal |
|---|---|---|
| 01 | Handoff Renderers | Convert session + Task Briefs into a target-specific pack folder (four built-in targets). |
| 02 | Handoff CLI | Add `diptych handoff` command; shared `writeHandoffPack` writer service. |
| 03 | Handoff Slash Command | Add `/handoff <target> [task-id]` for active sessions in the TUI. |
| 04 | Handoff Manifest Schema | Zod schema + `manifest.json` generation (depends on brief-hash-versioning). |
| 05 | Handoff Custom Renderers | Load user-defined renderers from `.diptych/handoff-renderers/<name>.ts`. |

## Pack Folder Shape (ADR-004)

Every Handoff Pack is a folder:

```
.diptych/sessions/<id>/handoffs/<target>/      ← slash command output (ADR-003)
./handoff/<target>/                            ← CLI default output (ADR-007)
├── manifest.json
├── spec.md            (if the session mode produced one)
├── plan.md            (if the session mode produced one)
├── constitution.md    (if present at project root)
├── tasks/
│   ├── T001.md
│   └── T002.md
└── README.md
```

## Done Criteria (ADR-011)

- Users can run `diptych handoff` without TUI and get a self-contained folder.
- Each target folder is consumable directly by the target tool (`claude`, `codex exec`, etc.)
  without any diptych involvement.
- Generated files include validation commands, constraints, escalation rules, and evidence.
- `manifest.json` is present in every pack and validates against `HandoffManifestSchema`.
- No target prompt or CLI flag causes diptych to spawn an external agent or push to a remote
  service. Handoff packs are inert artifacts.
- `npm run test-ci` passes across all five briefs.

## Quality Bar For Implementing Agents

- Renderers are pure and deterministic.
- CLI and TUI slash command use the same `writeHandoffPack` writer; no duplicated file-writing logic.
- Handoff files are always written under a deterministic path (CLI: `./handoff/<target>/`;
  slash: session folder per ADR-003).
- Generated prompts include Task Brief scope, validation, constraints, escalation, and evidence.
- External agents are never launched by this feature (ADR-001, ADR-011).
