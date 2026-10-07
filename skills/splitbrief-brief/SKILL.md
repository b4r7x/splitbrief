---
name: splitbrief-brief
description: >
  Plan only and write briefs; stop before implementation:
  "splitbrief brief", "write briefs", "prepare briefs for another agent".
  This session researches the outcome, asks bounded questions, and renders a typed plan
  with one self-contained Markdown brief per behaviour.
metadata:
  author: b4r7x
  version: "1.0.0"
  argument-hint: "[impl=<tool>[:<model>][@<effort>]] [review=<tool>[:<model>][@<effort>]] [cadence=end|task] [--ask [--yes]] <task | file>"
---

# splitbrief-brief

Run the planning procedure for task text or a file containing the request.
Write run artifacts only. Spawn no implementer or reviewer and edit no source files.
An implementer seat is optional; record an absent seat as `unselected`.

Stop after the typed plan and briefs pass admission and the optional approval is recorded.
Print the run directory, criteria, task ids, suggested files, dependencies, batches.
Print `next: splitbrief-run impl=<seat> cadence=<end|task> <run dir>`.
Keep the plan and briefs on disk for later execution.

## References

Read the applicable references before acting. This explicit list supplies the dependencies for an isolated install.

- references/family-map.md for entry selection, arguments, and engine command mapping.
- references/planning.md for the planning session, typed plan, and decisions ledger.
- references/brief-format.md for the Markdown contract and field placement.
- references/gates.md for validation, baselines, and change evidence.
- references/implementer-prompt.md for the completion report embedded in each brief.
