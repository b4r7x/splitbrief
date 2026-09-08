# Family Map

Shipped with every splitbrief skill. What runs before me, what runs after me.

    splitbrief-brief  ─→  splitbrief-run  ─→  splitbrief-review
    (Phase 0–1)           (Phase 2)            (Phase 3)
            └──────────── splitbrief ────────────┘
                     (all three, one invocation)

| Skill | Input | Writes | Hand-back names |
|---|---|---|---|
| `splitbrief` | task text or file + crew | run dir, source via the implementer (and the session on takeover) | the final verdict; nothing to chain |
| `splitbrief-brief` | task text or file | `<run dir>/` (`plan.md`, `baseline-tree.txt`, `spec.md`/`plan-notes.md` in standard, `briefs/`) and `.splitbrief/current-run` — never source | `splitbrief-run impl=<seat> <run dir>/briefs` |
| `splitbrief-run` | a briefs dir or one brief file + `impl=` | source via the implementer; `<run dir>/` (`plan.md`, `progress.md`, `evidence.md`, `baseline-tree.txt`, `T00N/`, `validation.md`, `drift.md`) and `.splitbrief/current-run` | `splitbrief-review intent: <run dir>` |
| `splitbrief-review` | `intent:` (run dir, spec file, or text) + `scope:` + optional `review=` | `plan.md`, `drift.md`, `review-packet.md`, `review/attempt-1.log`, `review.md` — never source | `splitbrief-run impl=<seat> error: <run dir>/review.md <run dir>/briefs` on Critical findings |

Shared vocabulary: the crew grammar `impl=<tool>[:<model>][@<effort>]` / `review=<…>` (all four), the run dir `.splitbrief/runs/<YYYY-MM-DD>-<HHmmss>-<slug>/` (all four), `.splitbrief/current-run` pointing at the newest run dir (written by `splitbrief`, `splitbrief-brief`, `splitbrief-run`), `--ask` (all four), the modes `quick` · `standard` · `plan` (`splitbrief` and `splitbrief-brief`), `--yes` (`splitbrief` only), `--no-escalate` (`splitbrief` and `splitbrief-run`), `error:` (`splitbrief-run` only), and the rule that nothing ever touches git: no add, no commit, no stash.

The SPLITBRIEF CLI (`npx splitbrief start`) remains the full product: sessions, TUI, isolation, snapshots, approval tiers, token accounting. These skills carry only the contract — brief, gates, drift, ladder, evidence-bound review, evidence trail.
