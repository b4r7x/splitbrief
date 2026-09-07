# Exec Progress
input: spec.md (spec mode) | mode: light, sequential | started: 2026-09-06
baseline: no website/ yet — gates bootstrapped in phase 1
reference: reference.png · shots: shots/ · design: website/DESIGN.md

| Phase | Batches | Tasks | Status | Cycles | Notes |
|---|---|---|---|---|---|
| 1 — foundation (package, tooling, tokens, skeleton) | 1.A | T-001..T-002 | done | 2 | 00:12 CLEAN after 1 fix cycle (font fallback metrics, .gitignore, reuseExistingServer:false, inline no-js swap, grain .06). Pins: vite 8.2 · ts 7.0 · vitest 5 · playwright 1.63 · biome 2.5 · @types/node 22. --passWithNoTests stays until T-004. |
| 2 — nav + hero left column | 2.A | T-003 | done | 2 | 01:40 fix-p2: Bodoni Moda opsz 20 (hairline 1.66% cap ≈ 1px @1×; sweep 48–72 sub-pixel), --text-display 5.4vw/4.9rem (fits 533px from 1100 up), fallback 0.00% diff, lede br+nbsp (rag 49/51/58), CTA width locked 282.8 both states, clipboard reject path + 4 tests, 9-dot AA, cta.css split (hero 140). y: 24/189/620/725/817. Orchestrator look: accepted. critic-p3 re-checks Phase 2 fixes. |
| 3 — diagram static (ghosts, card, routes, labels) | 3.A, 3.B | T-004..T-005 | done | 2 | 3.A done 02:05 (26 tests). 3.B (impl-p3b) cut by the session limit at 02:00 mid-task: scatter.ts 109 + scatter.test.ts 74 (3 tests, 29 total pass), mount.ts, diagram.css 184, brief.css (NOT in §13 — card styles split out, decide keep/merge), tools/render-static.ts, index.html 209 lines (65 = fallback art; over the 200 cap — needs a ruling), main.ts wires mountDiagram, main.css imports diagram+brief. Typecheck clean. Lint: 1 error (scatter.test.ts import organize — autofix) + 1 warning (unread). hero.css:117 still has a `display: none` (verify it is the `.stage` hand-off and delete). Shots p3s-* (01:56) = stage skeleton only; no p3 final shots, no coordinate table, no critique yet. critic-p3 11:30: 6/10, geometry exact (Δ ≤ 0.1%), faces wrong — F1 @-belt under implementer eyes, F2 cross-eyed pupils, F3 reviewer at breath trough at t=0, F4 louvre banding, F5 rain reads as leader line, F6 + on PLAN baseline, F7 lower-left void, F8–F10 code nits. Owner rulings: F5/F6/F7 accepted. fix-p3 (fable) dispatched 11:35 — cut by the Fable credit limit at 11:33 (wall) AFTER completing F1–F10 (no hand-back): rain.ts + test, pupils from void midpoint, CORE v .6 plateau, @ reserved for pupils, weave ×.85/×.88, reviewer phase 1.0, + at (30,70), lower-left trail, atlas alpha dropped, font fallback stack, §4/§5/§6 amended. Orchestrator verified 11:50: typecheck 0 · lint 37 clean · test 34/34 · build js 9.30 kB (gz 4.21) · shots p3fix-* · fallbacks 25/22/18. Re-critique 12:10: DONE 8/10, F1–F10 resolved (reviewer lit share ×3.6). Craft carried to T-006: crown apex density (CORE.ry .7→~.85 / crown edge ×.6), halo lit share (.05+.1n, inner ring only), rain bottom share 12→20%. |
| 4 — motion | 4.A | T-006 | validating | 1 | impl-p4 cut 14:02 → impl-p4b finished 16:10: fragments 28 stable (text-tight keep-clear, at-rest measurement, 2000 candidates, no mutual crossing), packet split (route-geometry 34 / timeline 28 / pose 45 / response 56 / packet 154 / find 5; ticker → features/diagram), halo .05+.1n, §7 rewritten to code (gaze/lift/gain/jolt pose, rain generations, card outline + tick flare + wake, entrance order, fragments). Removed as invisible or false: card row flip, label colour flash. No GSAP: js 16.80 kB gz 7.19. Gates: typecheck 0 · lint 50 clean · test 41/41 · e2e 10/10 (+4 shot skips). Self-score 8/10 (tell #8: 8 fragments in the header band). critic-p4 dispatched 16:15. |
| 5 — routes, manifesto, footer | 5.A | T-007 | pending | — | |
| 6 — responsive, floor, craft pass | 6.A | T-008 | pending | — | |
| 7 — extension research + design addendum | 7.A, 7.B | T-009..T-010 | pending | — | owner 00:20: extend with missing CLI substance |
| 8 — extension build | (from T-010) | T-011.. | pending | — | |

## Overnight protocol (owner, 2026-09-07 00:20)
- Run autonomously through Phases 2–8. One implementer at a time, fresh critic per phase, fix loop cap 2.
- Usage-limit hit → note the reset time here, schedule a wake-up (CronCreate) for reset + 2 min, resume from this table.
- Orchestrator context stays thin: agents return summaries; the orchestrator opens one fold PNG per phase.
- GSAP allowed for motion (spec + DESIGN updated 00:20). JS budget now ≤ 90 KB gz total / ≤ 12 KB gz own.

## Resume notes
- Spec review: ACCEPT (opus, cycle 3 of 3; 28 findings applied) — 2026-09-06 23:12
- Phase 1 implementer dispatched 2026-09-06 23:13 (fable, T-001 + T-002) — STOPPED 23:18: user rejected the plain-JS/no-build structure. Spec reset to Vite + TypeScript + vertical slices (DESIGN §13, spec.md Phases 1–6 rewritten). Old js/ and tools/ deleted; draft index.html + styles/ kept for T-002 to migrate.
- Structure re-review (opus): REJECT(8) → ACCEPT cycle 2 — 2026-09-06 23:37
- Phase 1 implementer re-dispatched 2026-09-06 23:38 (fable, T-001 + T-002 on the Vite/TS spec)
- Usage-window cuts: 2026-09-07 14:02 — impl-p4 hit the Fable credit limit mid-task (owner re-logged; recovered 14:20). 2026-09-07 11:33 — fix-p3 hit the Fable credit limit after completing its work (owner re-logged; recovered 11:50). 2026-09-07 10:51 — impl-p3b2 hit the Fable credit limit after finishing 3.B (owner re-logged; recovered 11:05). 2026-09-07 02:00 — impl-p3b hit the session limit ("resets 5:30am Europe/Warsaw"). Owner paused the run at 02:05 and asked for a branch + handoff.
