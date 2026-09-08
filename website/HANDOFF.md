# SPLITBRIEF website — handoff (2026-09-09 — built, validated, final sweep CLEAN)

The site was built by an orchestrated pipeline (nuke-spec → nuke-exec): one fable implementer per batch, a fresh fable critic per phase, fix loop cap 2, evidence in a ledger. Everything a maintainer needs is in this folder and `DESIGN.md`; the local run dir `.nuke/2026-09-06-225118-spec-website/` (gitignored) holds the same ledger files plus every screenshot.

## Read in this order

1. `DESIGN.md` — the design contract (tokens, geometry, copy, ghost algorithm, motion, responsive tiers, file map §13, verification §14, the §15 extension). The sheet wins over the reference image. Every shipped deviation is recorded in the section it belongs to.
2. `handoff/spec.md` — executor context (conventions, gates table, skill map), REQ-001..REQ-021, Phases 1–8 with tasks and mechanically checkable `Accept:` lines, execution protocol.
3. `handoff/exec-progress.md` — the phase ledger; every phase is `done`. The Phase 8 row ends with the final sweep's record.
4. `handoff/exec.md` — evidence per phase and cycle (gate outputs, critic verdicts, measurements).
5. `handoff/requirements.md`, `handoff/plan.md`, `handoff/prompt.md` (the original brief), `handoff/extension-research.md` (the §15 research), `handoff/reference.png` (the visual target, 1024 wide).

## State at finish (2026-09-09)

| Phase | Result | Capture kept |
|---|---|---|
| 1 foundation (Vite 8 · TS 7 · Vitest 5 · Playwright 1.63 `channel: 'chrome'` · Biome 2.5; tokens, base, skeleton, e2e harness) | done — validator CLEAN after one fix cycle | — |
| 2 nav + hero left column (Bodoni Moda `opsz 20`, calibrated fallback, CTA with clipboard) | done — accepted; re-checked inside the Phase 3 critique (8/10) | `handoff/p2fix-fold.png` |
| 3 diagram, static (ghosts, card, routes, labels, rain, scatter, no-JS art) | done — 8/10 after one fix cycle | run dir `shots/p3fix-*` |
| 4 motion (breath, rain drift, two packets at 55 px/s with wakes, seat responses, entrance, fragments; no GSAP) | done — 8/10 after one fix cycle | run dir `shots/p4fix-b-*` |
| 5 routes · manifesto · footer | done — 8/10 after one fix cycle | run dir `shots/p5fix-*` |
| 6 responsive tiers · a11y floor · craft pass (compact 350×980 stage) | done — 8/10 at 1440 and 390 after one fix cycle | `handoff/p6-390.png` |
| 7 extension research + DESIGN §15 addendum | done — opus ACCEPT, fable SHIP (cycle 2) | `handoff/extension-research.md`, `DESIGN.md` §15 |
| 8 extension build (T-011 markup · T-012 THE BRIEF 8/10 · T-013 THE LADDER 8/10 · T-014 THE RECORD 8/10 · T-015 integration) | done — final page 8/10 at 1440 and 390, SHIP; craft list applied by fix-final | `handoff/p8e-1440.png`, `handoff/p8e-fold.png`, `handoff/p8e-390.png` |

**Last gate run (final sweep, three consecutive runs identical):** `npm run typecheck` 0 · `npm run lint` "Checked 59 files … No fixes applied." · `npm test` 11 files, 45/45 · `npm run build` html 16.88 kB (gz 5.58) / css 21.38 kB (gz 5.30) / js 19.48 kB (gz 8.26) · `npm run e2e` 18 passed, 3 skipped (the `SHOT_DIR`-gated captures). A fresh copy without `node_modules`/`dist` passed `npm ci && npm run build && npm test && npm run e2e`. Headless load at 1440×900 and 390×844: 0 console errors, 0 warnings. `dependencies` is `{}`.

**Lighthouse (against `vite preview`, 2026-09-09):** desktop 100 / 100 / 100 / 91, mobile 97 / 100 / 100 / 91 (performance / accessibility / best practices / SEO). SEO 91 is the preview server's missing `robots.txt`, not the page.

**Owner-ruled deviations from the first sheet (each recorded in its DESIGN section):**
- Display face Bodoni Moda at `opsz 20` (Instrument Serif rejected by A/B); `--text-display: clamp(3.25rem, 5.4vw, 4.9rem)`.
- Compact stage: one spine at 38 %, annotation rail at 71.4 %; route C runs implementer → reviewer there (§11), with a `HANDOFF` dwell before the reviewer leg.
- Fragments: seed 8088 places 19 of 20 at 1440×900 (`worktree` is left out), 20 at 1024, 12 at 768, none below 768; travel 64 px; the header band, its quiet strip, the gutters, the label/seat blocks and the rain columns are keep-clear.
- Lede: four lines with `— three when another lab reviews.`, the `<br>` after `job —` hidden below 1250.
- Copy rulings: routes claim `MIX THE LABS. / ONE SHARED BRIEF.`; manifesto `03 EVIDENCE ON DISK`; ladder `if you have one`; `SAME TOOLS. / BETTER OUTPUT.` and `HIGHER QUALITY` kept as claims of intent; the CTA stays.
- `span.mark` (sheet and transcript marginal glyphs) at `--ink-3`; the nav's dot grid is scoped to `.nav .mark`. `--ink-4` at 2.08:1 accepted as decorative.
- Ladder: statements and fine print on cols 6–10 at ≤ 839; `li.retry` whole row `--ink-3`; rung labels may bleed ≤ 14 px into the col-4 gutter at 768–815.
- Brief sheet below 768 takes `order: 1` (claim → statements → the sheet cut by the crop rule).
- Record: phone notes as blocks at 12ch with a 3ch hang; `.requirements` a block with nbsp glue; `"add user auth"` hangs 2ch via `text-wrap: balance`.
- Hero at 768–1099: the diagram before works-with (`order: 1`).
- Card 108×104 (the 84 px sheet clipped `T3 jwt.test.ts`); reviewer gain ×0.7 removed.
- `@types/node` as a devDependency; `index.html` exempt from the 200-line cap for the art and the §15 bodies (its markup stays ≤ 220 by the §13 awk count).
- Shots and motion harness: the fake clock is installed and paused before `goto`, finished entrances drop to `animation: none` — two captures of one build are byte-identical.

**Residuals (known, not fixed):**
- Laptop fold at 768–1099: the diagram's crown sits at y ≈ 1 030 (1024) / 1 000 (768); bringing it under a 900 px fold needs ≈ 130 px from the headline block — the owner's call.
- 1024: one fragment sits ~30 px under the hero claim's dash.
- Design-level notes from the final critic: the ghost skirts read arcade at 2×; the 6 s reviewer leg is the loop's longest wait; the manifesto list is the weakest `01` device on the page; the `°` motif has no key until the ladder's fine print.
- `website/.claude/scheduled_tasks.lock` is a harness lock from the Sep-7 watchdog, excluded via `.git/info/exclude`; it is not part of the site.

## How to run

```bash
cd website
npm install                 # or npm ci
npm run dev                 # Vite dev server
npm run build               # → dist/ (base './', deployable under any path; serve over HTTP, never file://)
npm run preview             # serves dist/ on http://localhost:4173
npm run typecheck && npm run lint && npm test && npm run build && npm run e2e   # the gate
SHOT_DIR=/abs/dir SHOT_TAG=tag SHOT_TIME_MS=4000 npm run shots               # tag-1440.png, tag-fold.png, tag-390.png
npm run render-static       # frame-0 ghost art for the three <pre class="ghost-fallback">
```

Lighthouse: `npm run build && npm run preview`, then audit `http://localhost:4173/` (chrome-devtools `lighthouse_audit` or the DevTools panel), desktop and mobile. Chrome must be installed — Playwright runs on `channel: 'chrome'` and downloads no browser.

## Where things are

| DESIGN.md | Files |
|---|---|
| §1 tokens | `src/styles/tokens.css` (the only sheet with hex, font names or the spacing scale) |
| §2 skeleton, no-js swap | `index.html` (inline head script), `src/styles/base.css`, `src/styles/main.css` (layer order + imports) |
| §3 nav | `src/styles/nav.css` |
| §4 hero, CTA, diagram stage | `src/styles/hero.css`, `cta.css`, `diagram.css`; `src/features/copy-button.ts` (+ test); the two `route-lines` SVGs in `index.html` are the routes' single source |
| §5 brief card | `src/styles/brief.css` |
| §6 ghosts | `src/features/diagram/{seats,silhouette,density,atlas,ghost}.ts` (+ tests); `tools/render-static.ts` prints the fallback art |
| §7 motion | `src/styles/motion.css`; `src/features/diagram/{ticker,packet,timeline,pose,response,route-geometry,rain,mount}.ts`; `src/features/fragments/{pool,mount}.ts`; `src/main.ts` (keep-clear measurement, reduced-motion start/stop); `src/lib/reduced-motion.ts`, `src/lib/noise.ts` |
| §8 routes · §9 manifesto · §10 footer | `src/styles/routes.css`, `manifesto.css`, `footer.css` |
| §11 responsive tiers | `src/styles/diagram-compact.css` (the container query) and each sheet's `@media` blocks |
| §12 craft floor · §14 verification | `tests/e2e/page.e2e.ts`, `motion.e2e.ts`, `shots.e2e.ts`; `playwright.config.ts` |
| §15.1 THE BRIEF · §15.2 THE LADDER · §15.3 THE RECORD | `src/styles/brief-sheet.css`, `ladder.css`, `record.css`; `tests/e2e/extension.e2e.ts`; §15.4 holds the measured heights |
| §13 file map and rules | the tree above; gates in `handoff/spec.md` |

## Decisions already made (do not reopen without the owner)

- Stack: Vite + TypeScript strict, Vitest colocated unit tests (pure modules only), Playwright on the installed Chrome for e2e/screenshots/motion, Biome. Vertical slices: `src/features/` (flat below 3 files), `src/styles/` one sheet per section, `src/lib/` only on a second consumer, `tests/e2e/*.e2e.ts`. ≤ 200 lines per file, no barrels, no cross-feature imports (gate rows in spec.md).
- Copy: `splitbrief°`, ONE PLANS. / ONE EXECUTES. / ONE CONTRACT., `$ npm install -g splitbrief`, hero artifact `tasks.md` labelled TASK BRIEF, `°` = the seat that signs off, routes rows and all other strings in `DESIGN.md` verbatim (§15 included).
- Display face: Bodoni Moda at `opsz 20` (measured against the reference; Instrument Serif rejected by A/B). `--text-display: clamp(3.25rem, 5.4vw, 4.9rem)`.
- Motion concept (one): the system is alive and routing — ghost breath, rain into the ticks, two packets on `offset-path`, load entrance, seeded hovering fragments. `prefers-reduced-motion` = frame 0, no packets, static fragments. No GSAP shipped; JS budget ≤ 90 KB gz total, ≤ 12 KB gz own code (8.26 KB gz shipped).
- Mobile: a compact vertical 350×980 stage, same 7×11 cell grid, fit-scaled — never a scaled-down desktop stage.
- The three §15 sections are static: no keyframes, no transitions, no script (§7 stays five items).

## Process rules that bind every future agent

- Never `git add` / `git commit` / `git stage` unless the owner says so in that session (repo rule; a hook blocks it).
- Only `website/**` changes.
- Every visual task: shoot 1440-full / 1440-fold / 390-full, critique against `handoff/reference.png` naming the three worst things first, fix, re-shoot, `craft pass:` line, nuke-design tell-walk with a 1–10 score. A fresh critic must return ≥ 8/10 with zero `missed` on the phase surface; the orchestrator opens the fold PNG itself.
- Skills to load per file type are in `handoff/spec.md` Executor context; tool configs come from context7 docs, never memory.
- Log every usage-window cut and resume point in `handoff/exec-progress.md`.
