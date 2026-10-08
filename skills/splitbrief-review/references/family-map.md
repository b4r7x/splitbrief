# Family map

Choose the entry from the user's request. The names remain stable.

| Skill | Request | Selected stages | Writes |
|---|---|---|---|
| `splitbrief` | Plan this here, let another tool build it, then review and fix it. | planning, build, validation, review, bounded fixes | run artifacts; source through the implementer |
| `splitbrief-brief` | Plan only and write briefs. | planning and brief admission | run artifacts only |
| `splitbrief-run` | Build an existing plan, continue a stopped run, fix a failed review, or run one task. | saved or selected stage through review and bounded fixes | run artifacts; source through the implementer |
| `splitbrief-review` | Review someone else's build against its intent. | validation, read-only review, planner triage | review artifacts and appended fix briefs only |

## Seats and arguments

The host session is always the planner. The implementer builds; the reviewer checks the candidate read-only.
Without a reviewer seat, this session holds the review seat in a fresh pass.
The skills execute in the working tree. They require no SPLITBRIEF CLI, run workspace, or Apply step.

| Argument | Meaning |
|---|---|
| `impl=<tool>[:<model>][@<effort>]` | Select the implementer seat. Optional for planning only. |
| `review=<tool>[:<model>][@<effort>]` | Select the read-only reviewer seat independently of cadence. |
| `cadence=end` or `cadence=task` | Select review timing; default `end`. |
| `--ask` | Request one approval after the plan and briefs are rendered, or before standalone review. |
| `--yes` | Requires `--ask`; retains approval and permits ordinary gate-tooling repairs after approval. |
| `--status` | Inspect a saved run through `splitbrief-run`; return without dispatch. |

Tools are `claude`, `codex`, `opencode`, `copilot`, `kilo`, `cursor`, `cmd`, and `agy`.
Split each seat on the first `:` and last `@`.
For `impl=opencode:opencode-go/kimi-k3@high`, the tool is `opencode`, model is `opencode-go/kimi-k3`, and effort is `high`.
Normalize natural phrasing. Print the normalized crew, cadence, and selected stages before dispatch.
Resolve seats from inline arguments, then saved seats on continuation, then `.splitbrief/config.yaml` CLI seats.
If execution needs an absent implementer, probe available tools and ask once which seat to use.
Planning only needs no crew. Probe and invocation details belong to the tool recipes.

Approval options never bypass protected-action confirmation.
Explicit plan approval confirms only the protected paths and operations that the plan lists.
Without that explicit approval, ask before a protected write.
Use the host's question facility for approval and user-only decisions.

## Engine command mapping

| Engine command | Corresponding request |
|---|---|
| `spec` | Planning only through `splitbrief-brief`. |
| `start` | The complete pipeline through `splitbrief`. |
| `resume` | Continuation through `splitbrief-run`. |
| `status` | Inspection, equivalent in intent to `splitbrief-run --status`. |

These mappings describe user intent. Standalone skill records are not engine session state.
Do not feed a skill run directory to engine `resume` or claim state compatibility.
For an explicit engine run, use its configured crew and commands; `--plain` supplies text output.
The engine also owns its TUI, isolation, snapshots, and token accounting.
The CLI runs registered checks. Before each review the reviewer chooses the reviewer checks in the plan call, and the CLI runs them and stops at the first reviewer check with new failures. The reviewer returns the verdict and fix work in one answer. The CLI makes no planner triage call.
Render checks are unavailable in these skills.
