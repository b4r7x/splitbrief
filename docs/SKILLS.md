# SPLITBRIEF as agent skills

The pipeline — brief, gates, drift, retry ladder, evidence-bound review — packaged as four skills any coding agent can load. The CLI stays the full product (sessions, TUI, isolation, snapshots, approval tiers, token accounting); the skills carry the contract.

## Install

    npx skills add b4r7x/splitbrief

Non-interactive, one skill into several agents:

    npx skills add b4r7x/splitbrief -s splitbrief -a claude-code -a cursor -a opencode -a codex -a github-copilot -a antigravity -a command-code -a kilo -y

skills.sh installs into each agent's own skills directory (`.claude/skills`, `.agents/skills`, `.commandcode/skills`, `.kilocode/skills`, …). Add `-g` for a user-wide install. The picker lists the four skills under one `Splitbrief` group row (from `.claude-plugin/marketplace.json`), so one tick selects the whole pipeline.

Claude Code can also take the repo as a plugin marketplace, which installs all four at once and updates them together:

    /plugin marketplace add b4r7x/splitbrief
    /plugin install splitbrief@splitbrief

## The four skills

| Skill | Says | Does | Writes |
|---|---|---|---|
| `splitbrief` | "you plan, opencode implements, cursor reviews: add a health endpoint" | preflight → briefs → spawn per brief → gates → drift → ladder → review → hand-back | run dir + source via the implementer |
| `splitbrief-brief` | "compile briefs for this task" | preflight → briefs | run dir only |
| `splitbrief-run` | "run these briefs with cmd" | spawn per brief → gates → drift → ladder | run dir + source via the implementer |
| `splitbrief-review` | "review what cmd built against the briefs" | gates once → packet → verdict | run dir only (`plan.md`, `drift.md`, `review-packet.md`, `review/attempt-1.log`, `review.md`) |

## Grammar

    splitbrief [quick|standard|plan] impl=<tool>[:<model>][@<effort>] [review=<tool>[:<model>][@<effort>]] [--ask [--yes]] [--no-escalate] <task | file>

- Tools: `claude`, `codex`, `opencode`, `copilot`, `kilo`, `cursor`, `cmd`, `agy`.
- `impl=opencode:opencode-go/kimi-k3@high` → tool `opencode`, model `opencode-go/kimi-k3`, effort `high` (split on the first `:` and the last `@`).
- No `review=` → the session holds the review seat, exactly like the CLI without a `reviewer:` block.
- No `impl=` → read from `.splitbrief/config.yaml` when present; otherwise the skill asks once, listing the tools it found.
- Natural phrasing works; the plan block prints what was parsed.

Examples:

    splitbrief impl=cmd:deepseek/deepseek-v4-flash@high "add a /health endpoint returning {status:'ok'}"
    splitbrief standard --ask impl=opencode:opencode-go/kimi-k3 review=cursor:gpt-5.3-codex-high notes/feature.md
    splitbrief-brief "extract the retry helper into src/lib/retry.ts"
    splitbrief-run impl=codex@high .splitbrief/runs/2026-09-08-153000-retry-helper/briefs
    splitbrief-review review=claude:opus intent: .splitbrief/runs/2026-09-08-153000-retry-helper scope: branch

## Modes and flags

| | quick (default) | standard |
|---|---|---|
| artifacts | briefs | `spec.md` → `plan-notes.md` → briefs |
| cap | 5 briefs | 12 briefs |
| upgrade | > 5 files or > 5 briefs → standard, printed | > 12 → stop and recommend splitting |

`plan` prints the plan block and the briefs, writes nothing. `--ask` gates at the plan block (default: print and run); `--yes` alongside it keeps that one pause but applies gate-tooling fixes without asking. `--no-escalate` stops the ladder at the hint rung so the session never implements a brief itself.

## What maps to what

| Skill concept | CLI source |
|---|---|
| brief template, contract, critical rules | `src/engine/spec/prompts/task-format-example.ts`, `tasks.ts` |
| implementer preamble, rendering, retry framings | `src/engine/spec/prompts/system.ts`, `src/engine/spec/prompt-formatter.ts` |
| hint and takeover prompts | `src/engine/spec/prompts/escalation.ts` |
| reviewer prompt and verdict parsing | `src/engine/spec/prompts/review.ts`, `src/engine/parsers/final-review.ts` |
| gate resolution and narrowing | `src/engine/orchestrator/validation/` |
| drift | `src/engine/orchestrator/drift/analyze.ts` |
| halts on auth / usage | `src/engine/orchestrator/escalation/handle.ts` |
| tool argv | `src/engine/runners/cli-tools/*.ts` |

## Evidence trail

    .splitbrief/current-run                      → the newest run dir
    .splitbrief/runs/<YYYY-MM-DD>-<HHmmss>-<slug>/
      plan.md · progress.md · evidence.md · baseline-tree.txt
      spec.md · plan-notes.md            (standard)
      briefs/index.md · briefs/T001.md …
      T001/attempt-1.prompt.md · T001/attempt-1.log · T001/attempt-N.pid · T001/hint.md · T001/attempt-N.takeover.md …
      validation.md · drift.md
      review-packet.md · review/attempt-1.log · review.md

`.splitbrief/` is gitignored in this repo; elsewhere the plan block's `gitignore:` line says whether it is, once per run.

## Maintaining the skills

The CLI is the single source of truth. Every prompt block the skills share with it — the brief template, contract and critical rules, the implementer preamble and closing constraints, the retry framings, the hint and takeover prompts, the review packet, and the seven CLI-backed tool recipes — lives in the references between `<!-- generated: <id> -->` … `<!-- /generated -->` markers and is rendered by `scripts/skill-blocks.ts` from `src/engine/spec/prompts/*` and the adapters in `src/engine/runners/cli-tools/`. Change the CLI, run `npm run skills:sync`, and the skills follow; `npm run skills:check` (part of `release-check`) fails when a generated block, a mirror, or a frontmatter rule is out of date.

`skills/splitbrief/references/` is the only place the hand-written parts of a shared reference are edited; `skills:sync` mirrors the subset each optional skill mentions into its own `references/`. Source and mirrors are both committed — skills.sh reads the repo as is. The SPLITBRIEF CLI itself never injects the four pipeline skills into its planner prompt (they describe the loop it is already running); the repo's dev skills are unaffected.
