---
name: splitbrief-run
description: >
  Build an existing plan or brief set, resume or continue a stopped run, fix a failed
  review, or run one task from a single brief file: "splitbrief run", "run these briefs",
  "continue this run", "error: <review.md>", "run this one task".
  Runs through review and bounded fixes by default; --status inspects without dispatch.
metadata:
  author: b4r7x
  version: "1.0.0"
  argument-hint: "impl=<tool>[:<model>][@<effort>] [review=<tool>[:<model>][@<effort>]] [cadence=end|task] [--ask [--yes]] [--status] <plan | run dir | briefs dir | brief file | error: review.md>"
---

# splitbrief-run

This session holds the planner seat for the supplied work.
Use the shared run protocol for input admission, stage selection, dispatch, review, and bounded fixes.
Announce that execution includes review and fixes. Print the selected stages before dispatch.

Accepted requests:

- An existing typed plan or brief set starts at build.
- A prose plan enters typed conversion before build; preserve its stated outcome.
- A stopped run directory continues from its saved stage.
- `error: <review.md>` starts planner triage of the failed review.
- A single brief file selects one task and reports completion for that selection only.
- `--status` inspects the saved run and returns without dispatch.

Continuation, process reconciliation, dependency checks, and saved counters follow the run protocol.
Use its completion report for the selected work.

## References

Read the applicable references before acting. This explicit list supplies the dependencies for an isolated install.

- references/family-map.md for entry selection, arguments, and engine command mapping.
- references/planning.md for the planning session, typed plan, and decisions ledger.
- references/brief-format.md for the Markdown contract and field placement.
- references/run-protocol.md for dispatch, waiting, saved progress, continuation, and cadence.
- references/recovery.md for retries, consults, bounds, and finding triage.
- references/gates.md for validation, baselines, and change evidence.
- references/implementer-prompt.md for prompt construction and completion reports.
- references/review-format.md for the review packet, typed answer, and derived pass.
- references/tool-recipes.md for tool probes and invocation recipes.

Use the bundled scripts/wait-attempt.sh for waiting and reconciliation.
The optional scripts/splitbrief-gate.sh requires the user to authorize a host hook.
