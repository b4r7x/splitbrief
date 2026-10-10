---
name: splitbrief-review
description: >
  Review someone else's build against its intent while leaving source files unchanged:
  "splitbrief review", "review what cmd/opencode built", "review this change against the plan".
  Records validation and returns a typed read-only review whose answer carries the
  verdict and the fix work as review artifacts and new fix briefs.
metadata:
  author: b4r7x
  version: "1.0.0"
  argument-hint: "[review=<tool>[:<model>][@<effort>]] [cadence=end|task] [intent: <run dir | spec file | text>] [scope: changed|staged|branch|<path>] [--ask]"
---

# splitbrief-review

This entry authorizes review and the reviewer's fix work only. Edit no source files and dispatch no implementer.
Use the shared run protocol's review stage, the review format, and recovery's review fix work.
Write review artifacts and any appended fix briefs. A review request alone grants no permission to execute them.

`intent:` accepts a run directory, spec file, or task text.
Without it, read `.splitbrief/current-run`; ask for intent when no saved run identifies it.
Use the saved typed plan and briefs, or define typed criteria and registered checks before review.
`scope:` selects `changed` against HEAD, `staged`, `branch` against its base, or a path.
For a pipeline run, use the saved baseline instead of HEAD.
Print the intent, diff scope, selected tasks and criteria, pending criteria, crew, cadence, and recorded checks before review.
With `--ask`, record the optional review approval before the review call.

Print the derived verdict, task coverage, criterion evidence, findings, and unresolved decisions.
When fixes are ready, print `next: splitbrief-run impl=<seat> cadence=<end|task> error: <review.md>`.

## References

Read the applicable references before acting. This explicit list supplies the dependencies for an isolated install.

- references/family-map.md for entry selection, arguments, and engine command mapping.
- references/planning.md for the planning session, typed plan, and decisions ledger.
- references/brief-format.md for the Markdown contract and field placement.
- references/run-protocol.md for dispatch, waiting, saved progress, continuation, and cadence.
- references/recovery.md for retries, consults, bounds, and review fix work.
- references/gates.md for validation, baselines, and change evidence.
- references/implementer-prompt.md for prompt construction and completion reports.
- references/review-format.md for the review packet, typed answer, and derived pass.
- references/tool-recipes.md for tool probes and invocation recipes.

Use the bundled scripts/wait-attempt.sh for waiting and reconciliation.
The optional scripts/splitbrief-gate.sh requires the user to authorize a host hook.
