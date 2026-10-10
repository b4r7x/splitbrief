---
name: splitbrief
description: >
  Plan this here, let another coding tool build it, then review and fix it:
  "splitbrief", "you plan, X implements, Y reviews", "delegate to codex/opencode".
  This session plans, writes briefs, and runs the build through review and bounded fixes.
metadata:
  author: b4r7x
  version: "1.0.0"
  argument-hint: "impl=<tool>[:<model>][@<effort>] [review=<tool>[:<model>][@<effort>]] [cadence=end|task] [--ask [--yes]] <task | file>"
---

# splitbrief

This session holds the planner seat and orchestrates the full pipeline.
The implementer builds. The reviewer reads the candidate and evidence.

1. Normalize the request with the family map.
2. Plan the requested outcome with the planning procedure and render self-contained Markdown briefs.
3. Enter the shared run protocol at build, with review and bounded fixes selected.
4. Print the selected stages before dispatch and use the shared completion report.

These skills run in the working tree and require no SPLITBRIEF CLI.

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
