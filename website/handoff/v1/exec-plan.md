## Nuke Preflight — nuke-exec (spec mode)
spec: .nuke/2026-09-06-225118-spec-website/spec.md · mode: light (sequential, fable implementers, fable critics)
phases: 6 · batches: 7 · tasks: 8 · re-measured: none oversized (greenfield; every task ≤ 5 files)
phase 1 (foundation): 1.A [T-001..T-002]
phase 2 (nav + hero left): 2.A [T-003]
phase 3 (diagram static): 3.A [T-004] → 3.B [T-005]
phase 4 (motion): 4.A [T-006]
phase 5 (lower sections): 5.A [T-007]
phase 6 (responsive + floor + craft): 6.A [T-008]
tiers: implementers fable (T-001 may run opus) · critics fable, fresh · fix cap 2/phase · final sweep fable
stack: Vite + TypeScript strict + Vitest + Playwright (channel chrome) + Biome — vertical slices under src/features (RESET 2026-09-06 23:20: the first plain-JS/no-build spec was rejected by the user; its js/ and tools/ output deleted)
skill map: .html/.css → sota-structure, nuke-design, nuke-creative, frontend-design, web-design-guidelines, nuke-lean · .ts → sota-structure, typescript-best-practices, clean-code, nuke-lean · tests → test-behavior-not-implementation, webapp-testing · configs → context7 docs · critics → nuke-design (verification), nuke-creative
baseline: website/ has a draft index.html + styles/ from the superseded spec (reused by T-002); gates bootstrapped by T-001 (typecheck/lint/test/build/e2e/shots in website/); repo gates untouched (no src/ changes allowed)
estimate: ~14–24 agents sequential (8 implementers + 6 critics + fix cycles)
resume rule: a new session reads exec-progress.md, takes the first phase not `done`, re-reads spec.md + website/DESIGN.md, dispatches that phase's implementer with the task text verbatim
