---
generated_by: splitbrief v0.1.0
planner: claude-code (opus)
implementer: claude-code (opus)
mode: standard
created_at: 2026-09-25T08:56:22.403Z
---
---
id: T003
title: Keep the owner's committed files out of drift analysis
action: modify
file: src/engine/orchestrator/drift/analyze.ts
files:
  - src/engine/orchestrator/drift/analyze.ts
  - src/engine/orchestrator/drift/analyze.test.ts
depends_on: []
---

### Description
**How drift works today.** `analyzeBriefDrift` compares a run's changed files against the Task Briefs. At the final review, its universe is every file changed since the run-start head, plus the working tree.
---
id: T004
title: Report committed-only files and pass them to drift at the final review
action: modify
file: src/engine/orchestrator/evidence/review-packet/sections-io.ts
files:
  - src/engine/orchestrator/evidence/review-packet/sections-io.ts
  - src/engine/orchestrator/evidence/review-packet/sections-io.test.ts
  - src/engine/orchestrator/final-review.ts
  - src/engine/orchestrator/final-review.test.ts
  - docs/SUBSYSTEMS.md
  - docs/APPROVAL-AND-RECOVERY.md
depends_on:
  - T003
---

### Description
Brief T003 gave `analyzeBriefDrift` an optional input, `committedOnlyFiles`. Drift drops a committed-only file unless the run wrote it or a brief targets it. This brief computes that list and passes it in at the final review.
---
id: T005
title: Count a direct writer's promoted lines in implementer_generate_done
action: create
file: src/engine/implementers/pipeline/line-counts.ts
files:
  - src/engine/implementers/pipeline/line-counts.ts
  - src/engine/implementers/pipeline/line-counts.test.ts
  - src/engine/implementers/types.ts
  - src/engine/implementers/pipeline/run.ts
  - src/engine/implementers/pipeline/run.test.ts
depends_on: []
---

### Description
**The defect.** Direct-writing implementers (claude-code, opencode, antigravity) edit files in an isolation workspace, either a git worktree or a staged copy. The implementer pipeline (`src/engine/implementers/pipeline/run.ts`) publishes `implementer_generate_done` for them with `linesAdded: 0, linesRemoved: 0`. The transcript row therefore reads `<file> (+0 -0)`, while the promotion carries a real diff: run A's T016 was −25/+3.
---
id: T006
title: Hand the workspace snapshot to every direct-writer implementer call
action: modify
file: src/engine/orchestrator/task/run-implementation.ts
files:
  - src/engine/orchestrator/task/run-implementation.ts
  - src/engine/orchestrator/task/run-implementation.test.ts
  - src/engine/orchestrator/escalation/types.ts
  - src/engine/orchestrator/escalation/make-implementer-retry-invoker.ts
  - src/engine/orchestrator/escalation/make-implementer-retry-invoker.test.ts
  - src/engine/orchestrator/escalation/step.ts
  - src/engine/orchestrator/escalation/step.test.ts
depends_on:
  - T005
---

### Description
Brief T005 did three things:
---
id: T007
title: Stop naming promoted files as unpromoted leftovers at a fresh reseed
action: modify
file: src/engine/orchestrator/isolation/create.ts
files:
  - src/engine/orchestrator/isolation/create.ts
  - src/engine/orchestrator/isolation/create.test.ts
depends_on: []
---

### Description
**Background.** `createRunIsolation` hands every brief of a run the same git worktree. A brief's first attempt acquires it with `fresh: true`. Before the hand-out, `discardUnpromotedWork` does three things:
