# SPLITBRIEF as agent skills

The pipeline — brief, gates, drift, retry ladder, evidence-bound review — is packaged as four skills any coding agent can load. A fifth skill, `splitbrief-babysit`, supervises the built CLI while it develops its own repository. The CLI stays the full product (sessions, TUI, isolation, snapshots, approval tiers, token accounting); the pipeline skills carry the contract.

## Install

    npx skills add b4r7x/splitbrief

Non-interactive, one skill into several agents:

    npx skills add b4r7x/splitbrief -s splitbrief -a claude-code -a cursor -a opencode -a codex -a github-copilot -a antigravity -a command-code -a kilo -y

skills.sh installs into each agent's own skills directory (`.claude/skills`, `.agents/skills`, `.commandcode/skills`, `.kilo/skills`, `.kilocode/skills`, …). Add `-g` for a user-wide install. The picker lists the five skills under one `Splitbrief` group row (from `.claude-plugin/marketplace.json`).

Claude Code can also take the repo as a plugin marketplace, which installs all five at once and updates them together:

    /plugin marketplace add b4r7x/splitbrief
    /plugin install splitbrief@splitbrief

### Installers and `scripts/`

The waiter (`wait-attempt.sh`) and the stop-hook gate (`splitbrief-gate.sh`) ship inside the skill directories, so an installer that copied only `SKILL.md` and `references/` would leave the run protocol without its blocking primitive. Every installer that can be exercised today preserves `scripts/` with its executable bit; the commands, trees and versions behind this table are recorded in `.nuke/2026-09-13-094954-spec-loop-granularity-monitoring-parity/evidence/installers.md`.

| Installer | Command | Result | Fallback |
|---|---|---|---|
| skills.sh (local clone) | `npx skills add <path-to-clone> -s splitbrief-run -a claude-code -y` | `.claude/skills/splitbrief-run/scripts/wait-attempt.sh`, mode `755` | not needed |
| skills.sh (published repo) | `npx skills add b4r7x/splitbrief -s splitbrief-run -a claude-code -y` | unverified: the published `b4r7x/splitbrief` carries no `skills/` yet, so the clone succeeds and the CLI prints `No skills found` | the inline `until … done` waiter in the run skill's `wait-protocol` block |
| Claude Code plugin | `/plugin install splitbrief@splitbrief` | `scripts/` under every script-carrying skill in the plugin cache, mode `755` | not needed |
| Manual copy | `cp -R skills/splitbrief-run ~/.claude/skills/` | the directory as it stands in the repo | not needed |

Because one row is not `preserved`, `skills/splitbrief-run/SKILL.md`'s `wait-protocol` block carries the inline `until … done` waiter beside the script: same deadline, no halt sniff.

## The skills

| Skill | Says | Does | Writes |
|---|---|---|---|
| `splitbrief` | "you plan, opencode implements, cursor reviews: add a health endpoint" | preflight → briefs → spawn per brief → gates → drift → ladder → review → hand-back | run dir + source via the implementer |
| `splitbrief-brief` | "compile briefs for this task" | preflight → briefs | run dir only |
| `splitbrief-run` | "run these briefs with cmd" | spawn per brief → gates → drift → ladder | run dir + source via the implementer |
| `splitbrief-review` | "review what cmd built against the briefs" | gates once → packet → verdict | run dir only (`plan.md`, `drift.md`, `review-packet.md`, `review/attempt-1.log`, `review.md`) |
| `splitbrief-babysit` | "run splitbrief and babysit it" | watch the CLI → stop at the first tool defect → fix → verify → build → continue | CLI session record + tool repairs |

### Supervised dogfooding

`skills/splitbrief-babysit/` is self-contained when copied or installed alone. It needs no other skill, private `.nuke/` files, `jq`, or fixed agent model. It uses the repository's Node.js runtime and the host's interactive terminal; tmux is optional. The configured coding tools remain prerequisites for the CLI run.

The bundled `scripts/watch-run.mjs` polls the session log once per second and preserves its byte cursor between calls. Errors, failed validation, retries, warnings, and recovery events wake the supervisor. The supervisor stops the run; the watcher does not enforce an engine-level barrier. All detected tool defects, including visual defects and false tripwire alarms, require repair before further work. Model mistakes and correctly reported provider limits retain normal CLI recovery.

The watcher source follows the existing script library convention in `skills/splitbrief-run/scripts/`; `skills:sync` copies it into the installed babysit skill. No source-library path is needed at runtime. The four pipeline skills still use generated contract blocks; the babysit procedure is handwritten and its frontmatter and script mirror are checked by `skills:check`.

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
| briefs | one per coherent outcome, no count limit | one per coherent outcome, no count limit |

The CLI defaults to `standard` in an isolation worktree; these skills default to `quick` in the working tree — the one documented divergence between the two sides, and the only `intentional` row of `DIVERGENCE_TABLE` (`src/core/pipeline-spec/divergences.ts`). Everything else countable is rendered from the same spec, so it cannot drift silently.

`plan` prints the plan block and the briefs, writes nothing. `--ask` gates at the plan block (default: print and run); `--yes` alongside it keeps that one pause but applies gate-tooling fixes without asking. `--no-escalate` stops the ladder at the hint rung so the session never implements a brief itself.

## What maps to what

| Skill concept | Rendered from |
|---|---|
| brief template, contract, critical rules | `src/engine/spec/prompts/task-format-example.ts`, `tasks.ts` |
| implementer preamble and body rendering | `src/engine/spec/prompts/system.ts`, `src/engine/spec/prompt-formatter.ts` |
| hint and takeover prompts | `src/engine/spec/prompts/escalation.ts` |
| reviewer prompt and review packet | `src/engine/spec/prompts/review.ts` |
| retry ladder, framings, hint placement | `src/core/pipeline-spec/ladder.ts` |
| verdict rules and fix cycle | `src/core/pipeline-spec/review.ts` |
| gate order, capture limits, narrowing | `src/core/pipeline-spec/gates.ts`, `src/core/validation/stacks/` |
| allowed set, drift, baseline fingerprint | `src/core/pipeline-spec/scope.ts`, `baseline.ts` |
| modes, caps, upgrade thresholds | `src/core/pipeline-spec/modes.ts` |
| halt signatures on auth / usage | `src/core/pipeline-spec/halts.ts` |
| deadlines | `src/core/pipeline-spec/timeouts.ts` |
| tool argv | `src/engine/runners/cli-tools/*.ts` |

## Evidence trail

    .splitbrief/current-run                      → the newest run dir
    .splitbrief/runs/<YYYY-MM-DD>-<HHmmss>-<slug>/
      plan.md · progress.md · evidence.md · baseline-sha.txt
      events.log                         (one line per waiter verdict)
      spec.md · plan-notes.md            (standard)
      briefs/index.md · briefs/T001.md …
      T001/attempt-1.prompt.md · T001/attempt-1.log · T001/attempt-N.pid · T001/attempt-N.done · T001/hint.md · T001/attempt-N.takeover.md …
      validation.md · drift.md
      review-packet.md · review/attempt-1.log · review.md

`.splitbrief/` is gitignored in this repo; elsewhere the plan block's `gitignore:` line says whether it is, once per run.

## Maintaining the skills

The pipeline spec (`src/core/pipeline-spec/`) is the single source of truth; the orchestrator reads it and the skills are rendered from it. This reverses the 2026-09-08 design ("the CLI is the single source of truth"), per DECISIONS D6 (2026-09-13): the countable rules of the skills now come from the same module the orchestrator imports, and `npm run skills:check` fails when either side drifts.

Every block the skills share with the CLI lives between `<!-- generated: <id> -->` … `<!-- /generated -->` markers — `# generated: <id>` … `# /generated` inside a shell script — and the markers are no longer only in the references: the four `SKILL.md` files and `scripts/wait-attempt.sh` carry them too. `scripts/skill-blocks.ts` owns the renderers, `GENERATED_BLOCK_IDS` is the list, and each block reads one source:

| Source | Blocks |
|---|---|
| `src/core/pipeline-spec/` | `ladder-table`, `retry-framings`, `hint-placement`, `halt-signatures` and its shell form `halt-signatures-sh`, `gate-rules`, `modes-table`, `caps`, `body-order`, `closing-constraints`, `scope-rule`, `baseline-rule`, `timeouts`, `verdict-rules`, `fix-cycle`, `wait-protocol` |
| `src/core/validation/stacks/` | `gates` — the per-stack coverage, narrowing and allowed-command tables |
| `src/engine/spec/prompts/*`, `prompt-formatter.ts` | `brief-template`, `brief-contract`, `critical-rules`, `implementer-preamble`, `closing-line`, `hint-prompt`, `takeover-prompt`, `review-packet` |
| `src/engine/events/sinks/stdout-text.ts` | `plain-shapes` |
| `src/engine/runners/cli-tools/` | one `recipe:<tool>` per CLI adapter |

Change either side, run `npm run skills:sync`, and the skills follow; `npm run skills:check` (part of `release-check`) fails when a generated block, a mirror, or a frontmatter rule is out of date.

`skills/splitbrief/references/` is the only place the hand-written parts of a shared reference are edited, and `skills/splitbrief-run/scripts/` is the only place a script is edited. `skills:sync` mirrors the subset each optional skill mentions into its own `references/`, and copies each `scripts/<name>` a `SKILL.md` mentions byte-identically into that skill's own `scripts/`; a stale, missing, or no-longer-mentioned mirror fails `skills:check`. Source and mirrors are both committed — skills.sh reads the repo as is. The SPLITBRIEF CLI itself never injects the four pipeline skills or `splitbrief-babysit` into any seat's prompt (they describe the loop it is already running, and the babysit skill supervises the CLI itself); the contract reaches the planner from the pipeline spec instead. The repo's dev skills are unaffected.
