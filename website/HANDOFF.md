# SPLITBRIEF website — handoff (paused 2026-09-07 02:05, resume from Phase 3B)

The site is built by an orchestrated pipeline (nuke-spec → nuke-exec): one fable implementer per batch, a fresh fable critic per phase, fix loop cap 2, evidence in a ledger. Everything a new session needs is in this folder and `DESIGN.md`; the local run dir `.nuke/2026-09-06-225118-spec-website/` (gitignored) holds the same files plus every screenshot.

## Read in this order

1. `DESIGN.md` — the design contract (tokens, geometry, copy, ghost algorithm, motion, responsive tiers, file map §13, verification §14). The sheet wins over the reference image.
2. `handoff/spec.md` — executor context (conventions, gates table, skill map), REQ list, Phases 1–8 with tasks and mechanically checkable `Accept:` lines, execution protocol.
3. `handoff/exec-progress.md` — the phase table; resume from the first phase not `done`.
4. `handoff/exec.md` — evidence per phase/cycle (gate outputs, critic verdicts, measurements).
5. `handoff/requirements.md`, `handoff/plan.md`, `handoff/prompt.md` (the original brief), `handoff/reference.png` (the visual target, 1024 wide).

## State at pause

| Phase | Status |
|---|---|
| 1 foundation (Vite 8 + TS 7 + Vitest 5 + Playwright 1.63 `channel: 'chrome'` + Biome 2.5; tokens, base, full-copy skeleton, e2e harness) | done, validated |
| 2 nav + hero left column (Bodoni Moda opsz 20, calibrated fallback, CTA with clipboard, 4 unit tests) | done, validated — see `handoff/p2fix-fold.png` |
| 3A ghost pipeline (`src/lib/{noise,reduced-motion}.ts`, `src/features/diagram/{seats,silhouette,density,atlas,ghost}.ts`, 26 tests) | done, gates green |
| 3B diagram layout (`src/styles/diagram.css`, `brief.css`, `src/features/diagram/{scatter,mount}.ts`, `tools/render-static.ts`, fallback art in `index.html`) | **partial — cut by a usage limit mid-task**; see below |
| 4 motion (breath, rain, two packets, entrance, fragments; GSAP allowed) | pending |
| 5 routes / manifesto / footer | pending |
| 6 responsive tiers, a11y floor, craft pass | pending |
| 7 extension research + design addendum (what the CLI has that the page lacks) | pending |
| 8 extension build | pending |

### Exactly where 3B stopped

- Files exist: `scatter.ts` 109 + `scatter.test.ts` 74 (3 tests; 29 pass in total), `mount.ts`, `diagram.css` 184, `brief.css` (card styles — **not in DESIGN §13**; rule: keep as a §13 entry or fold into `diagram.css`), `tools/render-static.ts`, `main.ts` wires `mountDiagram`, `main.css` imports `diagram.css` + `brief.css`.
- `index.html` is 209 lines; 65 are the generated `<pre class="ghost-fallback">` art. Over the 200-line cap — rule: exempt generated art in `index.html` (record in §13) or move the art to `src/fallback/*.html` partials inlined by Vite.
- `npm run typecheck` clean. `npm run lint`: 1 error (`scatter.test.ts` import organize — Biome safe fix) + 1 warning (not yet read).
- `src/styles/hero.css:117` still has a `display: none` — confirm it is the `.stage` hand-off from Phase 2 and delete it once `diagram.css` positions the stage.
- Only stage-skeleton screenshots exist (`handoff/p3s-fold.png`); no coordinate table, no critique, no final `p3` shots.

### First moves for the next session

1. `cd website && npm ci && npm run lint -- --write` (or fix by hand), read the warning, `npm run typecheck && npm test && npm run build && npm run e2e`.
2. Rule on `brief.css` and the `index.html` line cap; update `DESIGN.md §13` accordingly.
3. Finish T-005 per `handoff/spec.md` Phase 3 Batch 3.B: measure every §4 element vs its stage coordinate (±3%), the card as an object, routes meeting the quoted rims, scatter/halos, reviewer legibility (3A flagged it faint by design — raise gain within §6 if it reads as dirt), delete the `hero.css` hand-off line, shoot `SHOT_DIR=… SHOT_TAG=p3 npm run shots`, critique three-worst-first, craft pass, tell-walk.
4. Fresh critic on Phase 3 (charter in spec.md "Execution protocol" §2 — also re-checks the Phase 2 fixes). Then Phase 4.

## Decisions already made (do not reopen without the owner)

- Stack: Vite + TypeScript strict, Vitest colocated unit tests (pure modules only), Playwright on the installed Chrome for e2e/screenshots/motion, Biome. Vertical slices: `src/features/` (flat below 3 files), `src/styles/` one sheet per section, `src/lib/` only on a second consumer, `tests/e2e/*.e2e.ts`. ≤ 200 lines per file, no barrels, no cross-feature imports (gate rows in spec.md).
- Copy: `splitbrief°`, ONE PLANS. / ONE EXECUTES. / ONE CONTRACT., `$ npm install -g splitbrief`, hero artifact `tasks.md` labelled TASK BRIEF, `°` = the seat that signs off, routes rows and all other strings in `DESIGN.md` verbatim.
- Display face: Bodoni Moda at `opsz 20` (measured against the reference; Instrument Serif rejected by A/B). `--text-display: clamp(3.25rem, 5.4vw, 4.9rem)`.
- Motion concept (one): the system is alive and routing — ghost breath, rain into the ticks, two packets on `offset-path`, load entrance, seeded hovering fragments. `prefers-reduced-motion` = frame 0, no packets, static fragments. GSAP allowed where a native timeline would be clumsy; JS budget ≤ 90 KB gz total, ≤ 12 KB gz own code.
- Mobile: a compact vertical 350×980 stage, same 7×11 cell grid, fit-scaled — never a scaled-down desktop stage.

## Process rules that bind every future agent

- Never `git add` / `git commit` / `git stage` unless the owner says so in that session (repo rule; a hook blocks it).
- Only `website/**` changes.
- Every visual task: shoot 1440-full / 1440-fold / 390-full, critique against `handoff/reference.png` naming the three worst things first, fix, re-shoot, `craft pass:` line, nuke-design tell-walk with a 1–10 score. A fresh critic must return ≥ 8/10 with zero `missed` on the phase surface; the orchestrator opens the fold PNG itself.
- Skills to load per file type are in `handoff/spec.md` Executor context; tool configs come from context7 docs, never memory.
- Log every usage-window cut and resume point in `handoff/exec-progress.md`.
