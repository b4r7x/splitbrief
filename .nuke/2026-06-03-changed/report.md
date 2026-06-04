# Nuke Audit Report — diptych — working-tree changes vs HEAD
run: .nuke/2026-06-03-changed/ · started 2026-06-03 · closed 2026-06-04 (user-directed)
scope: 111 files (92 modified / 2 deleted / 17 new), ~1849+ / 863− lines

## Verdict

**75 confirmed findings** (0 critical / 3 high / 11 medium / 39 low / 22 info), 52 candidates rejected by skeptics.
**NOT converged**: rounds trail 57 → 18 new; the protocol requires 2 consecutive dry rounds and round 2 still surfaced 18 — the loop was closed early by user instruction. Expect residual findings, particularly in areas only the miss-hunter touched once (docs drift outside the changeset, old-state compatibility, config/CI interactions).

## Rounds

| Round | Wave | Candidates | Confirmed new | Rejected | dry |
|---|---|---:|---:|---:|---:|
| 1 | 117 auditors: 11 lenses × 10 dir-chunks + 4 cross-cutting + 3 security surfaces | 137 (98 after dedupe) | **57** (F-001..F-057) | 41 | 0 |
| 2 (final, user-capped ≤30) | 27 auditors: 2 lens-groups × 8 feature-chunks + 7 cross-cutting + 3 fresh-eyes + 1 miss-hunter | 37 (29 after dedupe) | **18** (F-058..F-075) | 11 | 0 |

Operational notes (honest reporting): round 1 needed one resume after 12 tail agents + the dedupe judge failed structured output; a first 99-auditor round-2 attempt was aborted by the provider weekly limit; the capped rerun succeeded but its scribe hit a session limit — the round-2 ledger entries were reconstructed losslessly from the workflow journal by the orchestrator. Total ≈ 20M subagent tokens, ~245 agents.

## Scorecard (1–5; 5 = no issues found; target after fix-spec execution: 5/5 everywhere)

| Lens | Score | Why |
|---|:---:|---|
| correctness | **2** | 3 high (attach Ctrl+C freeze F-001; failed-final-review resume dead-end F-002/F-008; broken test gate under /tmp symlink F-003) + mediums (SIGINT alt-buffer F-004, sandbox credentials F-010, TUI stuck F-061) |
| errors | **2** | Failed-review state machine traps resume (F-002); promote throw escapes uncaught (F-006); silent lstat drop (F-025); silently dropped CLI flags (F-043) |
| tests | **2** | Broken gate on macOS /tmp (F-003); missing coverage for changed critical paths (sandboxEnv threading F-022/F-068, deletion cases F-019/F-066, ESC gate F-011); harness mute bugs (F-035/F-036); brittle verbatim-copy coupling (F-040/F-050) |
| performance | **3** | Staged no-git gate re-reads all file contents (F-005); unbounded read-stream fan-out EMFILE risk (F-020) |
| structure | **3** | Status laundered through disk (F-009); duplicated branches in final-review (F-027); misc lows |
| dry | **3** | Repeated shapes/types/helpers (F-013/14/15/18/23/24/32/48/57) — all low/info but numerous |
| simplicity | **3** | Speculative param (F-052), dead filters/guards (F-034/F-038), re-spread blocks (F-014), hand-rolled mocks (F-039) |
| hygiene | **3** | Docs drift incl. stale SLASH-COMMANDS abort model (F-058, medium) and 10 undocumented new flags (F-062); 3 more doc lies (F-063/070/071) |
| security | **4** | No exploitable vuln; tier-1 hint escalation unsandboxed (F-007, med, also correctness); split-paste edge in stdin bridge (F-069); sandbox env redirect verified otherwise sound |
| architecture | **4** | Cross-layer mapping duplication (F-048); disk-as-API (F-009, shared with structure); boundaries otherwise respected |
| types | **4** | Inline union/shape re-spelling (F-015/18/23/24/32/57) — low/info only |
| slop | **4** | Scattered low/info: dead fields (F-017), duplicate import (F-021), over-engineered guard (F-038) |
| dead-code | **4** | Dead env param (F-073), unreachable preferences (F-074), unused frames (F-055) — small and local |
| conventions | **4** | Lone class in harness (F-054), relative imports (F-041), duplicate React keys (F-016) |
| stack | **4** | Current idioms generally followed; only info-level gaps (F-045 missing TOCTOU comment, F-072 stale comment) |

All lenses can reach 5/5 by executing fix-spec.md — no finding lacks a concrete fix.

## Theme summary

1. **Final-review gate half-wired (worst cluster).** The changeset makes final review blocking, but a failure strands every consumer: resume dead-ends (F-002/F-008), TUI sticks (F-061), headless exits 0 (F-059), status is read back from disk (F-009).
2. **Sandbox is leaky in both directions.** Real env leaks in via unsandboxed tier-1 hint escalation (F-007); needed credentials are locked out by the HOME/XDG redirect (F-010); staging leaks temp dirs on failure (F-067); change detection silently degrades inside nested git repos (F-026) and re-reads the world per gate (F-005).
3. **Input rework regressions at the edges.** Attach-mode Ctrl+C freeze (F-001), SIGINT alt-buffer corruption (F-004), split paste markers (F-069), cancelled-state ESC bypassing the debounce (F-064), hidden two-press exit off-workflow (F-065).
4. **New CLI flags under-finished.** NaN-silent numeric parsing (F-012), env:NAME unresolved on agent-sdk (F-060), flags silently dropped per runner kind (F-043), and zero documentation (F-062).
5. **Docs lag the rename wave.** pending→armed and the new abort model are documented inconsistently in 4 docs (F-058/063/070/071).

## Artifacts

| File | Content |
|---|---|
| `findings.md` | Full ledger: 75 confirmed (with evidence + traces), 52 rejected (with refutation reasons) |
| `fix-spec.md` | Self-contained execution spec: 71 tasks, 4 dependency-ordered phases, coverage map for all 75 findings |
| `rounds.md` | Per-round wave composition + honest convergence log |
| `context.md` / `quality-bar.md` / `files.txt` | Audit inputs: project snapshot, SOTA bar, scope list |
