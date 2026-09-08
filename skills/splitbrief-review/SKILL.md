---
name: splitbrief-review
description: >
  Use when a change made by another tool, a cheaper model, or a colleague
  should be reviewed against its briefs, spec, or stated intent with recorded
  evidence — "splitbrief review", "review what cmd/opencode built", "review this
  diff against the briefs". Runs the project's gates once, assembles a review
  packet, and gets a verdict from a read-only reviewer tool or from this
  session; validation claims must quote the recorded output. Read-only: it
  names the splitbrief-run invocation for fixes. Whole pipeline: splitbrief.
metadata:
  author: b4r7x
  version: "1.0.0"
  argument-hint: "[review=<tool>[:<model>][@<effort>]] [intent: <run dir | spec file | text>] [scope: changed|staged|branch|<path>] [--ask]"
---

# splitbrief-review

Phase 3 of the splitbrief pipeline (map: references/family-map.md). One stateless, read-only review call with evidence-bound rules. Writes only `plan.md`, `drift.md`, `review-packet.md`, `review/attempt-1.log`, and `review.md` under the run dir — never source.

## Arguments

`review=<seat>` — the reviewer tool; absent → this session reviews.
`intent:` — a run dir (its `briefs/` and `spec.md` are the intent), a spec file, or text. Text is turned into numbered acceptance criteria first and printed in the plan block. Absent → the newest `.splitbrief/runs/*` dir with a `briefs/` folder; none → ask.
`scope:` — `changed` (vs HEAD, default) | `staged` | `branch` (vs `main`/`master`) | `<path>`.
`--ask` — pause at the plan block.

## Mandates

1. **Evidence-bound.** Every test/typecheck/lint claim in the verdict quotes the Recorded Validation Output or states that validation was not recorded.
2. **Read-only.** The reviewer runs in the tool's plan / read-only mode; this skill never edits source.
3. **One verdict word.** `pass` | `pass_with_notes` | `fail`, parsed per references/review-format.md; ambiguity is `fail`.
4. **Never substitute a seat.** A reviewer that is not installed, signed out, or given an unlisted model halts.

## Phase 0 — Preflight

1. Resolve the reviewer (references/tool-recipes.md probes) when given.
2. Resolve gates (references/gates.md); run them once over the whole project; capture verbatim — this is the Recorded Validation Output.
3. Resolve the diff for `scope:` (`git diff`, `git diff --cached`, `git diff <base>...HEAD`, or `git diff -- <path>`; untracked files via `git diff --no-index /dev/null <file>`). Paths under `.splitbrief/` are always excluded from the diff and the drift set; when the intent run dir has a `baseline-tree.txt`, files listed there are excluded too — they were dirty before the run.
4. Drift: when the intent is a run dir, compute changed files (minus `baseline-tree.txt`) vs the briefs' `file` + approved out-of-bounds paths (references/gates.md) and write `drift.md`; otherwise the packet says `Drift: not applicable (no briefs)`.
5. Print the plan block:

    ## SPLITBRIEF preflight — <slug> (review only)
    intent: .splitbrief/runs/2026-09-08-153000-slugify/ (2 briefs) · scope: changed (3 files, +84 −6)
    crew: review cursor:gpt-5.3-codex-high (auth ok, model listed)
    gates: typecheck PASS · lint none · test PASS (14 passed)
    drift: none
    run dir: <the intent run dir, or .splitbrief/runs/<stamp>-review-<slug>/>
    gitignore: .splitbrief/ ignored   (or: NOT ignored — add it to .gitignore or expect the run dir in git status)

6. `--ask` → wait. Otherwise write `plan.md` and continue.

## Phase 3 — Review

1. Write `review-packet.md` per references/review-format.md.
2. Spawn the reviewer recipe (read-only) with the packet as the prompt, 10-minute timeout, output → `review/attempt-1.log`; or answer the packet yourself in a fresh pass over the file. Write the reply to `review.md`.
3. Parse verdict, criteria, findings.

## Hand-back

    ## SPLITBRIEF review — <slug>
    crew: review cursor:gpt-5.3-codex-high · intent: <path> · scope: changed
    ### Recorded validation output
    <verbatim>
    ### Review
    verdict: fail · criteria 3/4 PASS · findings: 1 critical · 0 warning · 1 note
    - **[FAIL]** … (verbatim)
    - **Critical**: … (verbatim)
    Verdict: FAIL — 1 critical finding · next: splitbrief-run impl=<seat> error: <run dir>/review.md <run dir>/briefs

`pass` / `pass_with_notes` → `Verdict: PASS[_WITH_NOTES] — …` with the notes verbatim.

## Orchestration notes

- **Any host:** foreground spawn with the host's timeout; detach with `nohup … & echo $! > <pid file>` and poll `kill -0` when the host caps below 10 minutes.
- **Claude Code:** `run_in_background: true`; `--ask` via `AskUserQuestion`.
- **Other hosts:** plain questions; resume from the run dir.
