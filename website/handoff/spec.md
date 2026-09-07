# Build spec — SPLITBRIEF website

source: requirements.md (20 requirements, 5 non-goals) · design: `website/DESIGN.md` (read whole, every task)
mode: light (sequential — one implementer at a time; fable for every visual task)
run_dir: .nuke/2026-09-06-225118-spec-website · reference render: `reference.png` · screenshots: `shots/`

## Executor context

**Project:** SPLITBRIEF — an open-source orchestrator for two AI coding tools; the stronger one plans, compiles Task Briefs, and reviews, the weaker one executes them; SPLITBRIEF holds the contract, validation, retry, escalation, and evidence. This spec builds its static marketing site under `website/`, separate from the CLI build.

**Conventions (binding):**
- Never `git add` / `git commit` / `git stage` — a PreToolUse hook blocks it; leave everything unstaged.
- Only `website/**` may change (REQ-001). Read `website/DESIGN.md` in full before the first edit; it is the design contract, section numbers in tasks refer to it.
- `website/` is a self-contained Vite + TypeScript package (REQ-002): `dependencies` at most `gsap` (motion only, imported per module, used only under `src/features/**`), devDependencies only `vite`, `typescript`, `vitest`, `@playwright/test`, `@biomejs/biome`, `tsx`, `@types/node` (matching the Node major — `process.env` in the e2e files and vite's own `/// <reference types="node" />` need it). Current docs via context7 (`mcp__context7__resolve-library-id` → `query-docs`) before writing any config for those tools.
- sota-structure (REQ-017): behaviour features under `src/features/` (flat file below 3 files, folder at 3+; basenames never echo the folder), stylesheets in `src/styles/`, shared `src/lib/` only on a second consumer, features never import each other, `src/main.ts` composes; kebab-case; basename = primary export; no `utils`/`helpers`/`common`; no `index.ts` barrels; colocated `*.test.ts` (Vitest, `environment: 'node'`, pure modules only); e2e under `tests/e2e/*.e2e.ts` (Playwright); ≤ 200 lines per file. TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; no `any`, no `!`, no `as` casts outside `document.querySelector` narrowing.
- CSS: cascade layers in this order `tokens, base, layout, sections, motion`; tokens only in `tokens.css` (REQ-005); nesting allowed; container queries for the diagram tier; `text-wrap: balance` on headings, `pretty` on paragraphs.
- Fonts per DESIGN §1 with size-adjusted fallbacks (REQ-004).
- Motion per DESIGN §7 only; reduced motion honoured in CSS and JS (REQ-008).
- Look-and-logic loop is binding: every visual task ends with `SHOT_DIR=<run_dir>/shots SHOT_TAG=<tag> npm run shots` (in `website/`), a written critique against `reference.png` that names the three worst things first, fixes, re-shoot, `craft pass:` line, tell-walk with a 1–10 score (DESIGN §14, nuke-design).
- No decorative comments, no section banners, no dead code, no `.bak` files.

**Gates (website/ — bootstrapped by T-001; run from `website/`):**

| path | command | pass |
|---|---|---|
| `website/**` | `npm run typecheck` (`tsc --noEmit`) | exit 0 |
| `website/**` | `npm run lint` (`biome check .`) | exit 0 |
| `website/src/**` | `npm test` (`vitest run`) | all pass |
| `website/**` | `npm run build` | exit 0, `dist/index.html` present |
| `website/**` | `npm run e2e` (`playwright test`) | all pass |
| `website/**` | `SHOT_DIR=<run_dir>/shots SHOT_TAG=<tag> npm run shots` | three PNGs written |
| `website/**` | `grep -ri "orch" website/index.html website/src -l` | no output (REQ-003; `orchestrat*` is also banned in copy) |
| `website/src/features/**` | `grep -rn "from '\.\./" website/src/features` | every printed line imports from `lib/` (`../lib/` from flat files, `../../lib/` from folders); any other parent import is a cross-feature import and fails (REQ-017) |
| `website/src/**` | `grep -rn 'Math.random' website/src` | no output (REQ-007, REQ-010 determinism) |
| repo | `git status --porcelain` | only `website/` paths |

**Tier assignments:** implementers `fable` (all visual tasks; T-001 may run on `opus`) · critics `fable`, fresh context, one per phase · fix cycles cap 2 per phase · spec reviewer `opus`.

**File-type → skill map (mandatory loads):** `.html/.css` → `sota-structure`, `nuke-design` (build half), `nuke-creative` (charter), `frontend-design`, `web-design-guidelines`, `nuke-lean` · `.ts` → `sota-structure`, `typescript-best-practices`, `clean-code`, `nuke-lean` · `*.test.ts` / `*.e2e.ts` → `test-behavior-not-implementation`, `webapp-testing` · configs (`vite.config.ts`, `playwright.config.ts`, `vitest.config.ts`, `biome.json`, `tsconfig.json`) → context7 docs for that tool, `sota-structure` · critics → `nuke-design` (verification half), `nuke-creative`.

**Render tool:** Playwright `channel: 'chrome'` against `vite preview` (Chrome 152 is installed at `/Applications/Google Chrome.app`). `mcp__chrome-devtools__*` is available for interactive inspection (element boxes, console, `evaluate_script`) — navigate to `http://localhost:4173` after `npm run build && npm run preview`.

**SOTA sources encoded here:** cascade layers / container queries / `:has()` Baseline (polgubau.com modern-css-2026, css-zone.com); glyph-atlas ASCII rendering (alexharri.com/blog/ascii-rendering, offscreencanvas.com advanced-ascii-rendering); `prefers-reduced-motion` via CSS + `matchMedia` for canvas (MDN, web.dev/learn/accessibility/motion); font loading — preconnect both hosts, `display=swap`, `size-adjust`/`ascent-override` fallbacks, preload only above-the-fold faces (web.dev/articles/font-best-practices, css-tricks.com/the-fastest-google-fonts).

## Requirements (verbatim from requirements.md)

- REQ-001 The site lives entirely under `website/`; nothing outside it changes. `git status --porcelain` shows only `website/` paths.
- REQ-002 `website/` is a self-contained Vite + TypeScript package: `npm ci && npm run build` produces `dist/`; `dependencies` holds at most `gsap`; `base: './'` keeps `dist/` deployable under any path.
- REQ-003 Every string of copy on the page equals DESIGN.md §3, §4, §5, §8, §9, §10 verbatim. No "orch" anywhere in `website/`.
- REQ-004 Fonts load from Google Fonts with `preconnect` to both hosts, `display=swap`, exactly the three families and weights in §1, and each family has a size-adjusted local fallback `@font-face`.
- REQ-005 All colours, fonts, and spacing are custom properties in `styles/tokens.css`; no other stylesheet contains a hex colour, a font-family name, or a pixel spacing value outside the §1 scale — except geometry DESIGN §3–§11 declares literally (cell grid, tick lengths, row pitches, card and CTA boxes, the stages).
- REQ-006 At 1440 wide the hero is a 12-column grid, left column cols 1–5, diagram cols 6–12, and every diagram element sits within ±3% of its §4 coordinate (measured on the screenshot).
- REQ-007 Three ghost canvases render the §6 silhouette on a locked 7×11 cell grid via a prerendered glyph atlas; rendering is deterministic; the pure functions are unit-tested with Vitest, colocated.
- REQ-008 Motion is exactly the five items of §7 and nothing else; `prefers-reduced-motion: reduce` yields frame 0 only, no packet, static fragments, instant entrance.
- REQ-009 Both packets (`.packet--impl` on routes A+B, `.packet--rev` on route C) travel their drawn polylines via `offset-path` and stay glued to the lines when the stage is scaled.
- REQ-010 Background fragments come from the §7.5 pool, never overlap the headline, lede, or CTA, and never exceed opacity .35.
- REQ-011 The routes section is a semantic `<table>` with exactly the five §8 rows.
- REQ-012 The manifesto and footer match §9 and §10.
- REQ-013 Responsive tiers per §11: at 390 wide no horizontal scroll, compact vertical diagram stage, ghost cell grid 7×11 CSS px before the stage's uniform fit-scale (1.0 at 390).
- REQ-014 Accessibility floor per §12/§14 of requirements.md.
- REQ-015 Zero console errors in the e2e run; built JS ≤ 90 KB gzipped total, own code ≤ 12 KB gzipped.
- REQ-016 `npm run shots` writes the three PNGs into `SHOT_DIR`; `npm run e2e` runs `page.e2e.ts` + `motion.e2e.ts`; typecheck/lint/test scripts exist and pass.
- REQ-017 Structure per DESIGN §13 and sota-structure (TypeScript strict; features flat below 3 files, folders at 3+; stylesheets in `src/styles/`; no path-echo basenames; colocated tests; ≤ 200 lines; no barrels; no cross-feature imports).
- REQ-018 CTA copies `npm install -g splitbrief` and announces `copied to clipboard` for 1.6 s.
- REQ-019 With JS disabled (`html.no-js`), each ghost's `<pre class="ghost-fallback" aria-hidden="true">` shows the frame-0 art from `tools/render-static.ts` and the canvas is hidden; with JS the `<pre>` is hidden.
- REQ-020 Every phase hands back three screenshots, a critique vs `reference.png`, a `craft pass:` line, a tell-walk; a fresh critic returns `earned` before the phase is done.

## Phase 1 — Foundation: package, tooling, tokens, skeleton

### Batch 1.A (one implementer, fable)

**T-001 Package scaffold, configs, e2e harness.** Files: `website/package.json`, `website/tsconfig.json`, `website/vite.config.ts`, `website/vitest.config.ts`, `website/playwright.config.ts`, `website/biome.json`, `website/tests/e2e/page.e2e.ts`, `website/tests/e2e/shots.e2e.ts`, `website/README.md`, `website/src/main.ts` (one-line stub: the `no-js` → `js` swap), `website/index.html` (entry repoint only: replace the draft's `<script src="js/main.js">` with `<script type="module" src="/src/main.ts">` and `<link href="styles/main.css">` with `/src/styles/main.css`; move the draft `website/styles/*.css` to `website/src/styles/` unchanged so the build resolves — T-002 rewrites their content).
Exactly as DESIGN §13 describes each file. `package.json`: `"private": true`, `"type": "module"`, empty `dependencies`, devDependencies pinned to the current majors found via context7 (`vite`, `typescript`, `vitest`, `@playwright/test`, `@biomejs/biome`, `tsx`), scripts `dev`, `build` (`vite build`), `preview` (`vite preview --port 4173 --strictPort`), `typecheck` (`tsc --noEmit`), `lint` (`biome check .`), `format` (`biome format --write .`), `test` (`vitest run`), `e2e` (`playwright test`), `shots` (`playwright test tests/e2e/shots.e2e.ts`), `render-static` (`tsx tools/render-static.ts`). `playwright.config.ts`: `use.channel = 'chrome'`, `webServer` = `npm run build && npm run preview` on `http://localhost:4173` with `reuseExistingServer`, `testDir: 'tests/e2e'`, `testMatch: '**/*.e2e.ts'`, one project `chromium-desktop` (1440×900) and the mobile viewport set per test. `page.e2e.ts`: every assertion listed in §13 for that file (the five-row table and the JS-budget assertions may be `test.skip` with a printed reason until the file they need exists — remove the skip in the phase that lands it). `shots.e2e.ts`: the three captures per §13 (`SHOT_DIR`, `SHOT_TAG`; `SHOT_TIME_MS` seeks CSS animations via `document.getAnimations()` pause + `currentTime` and advances `page.clock` for the rAF loops). `README.md` ≤ 10 lines. `npm install` runs here (network); commit nothing.
Accept: `cd website && npm run typecheck && npm run lint && npm test` exit 0 (vitest may report "no test files" only in this phase — that is a pass here; use `--passWithNoTests`); `npm run build` exits 0 and `ls dist/index.html` lists the file (the draft entry is repointed in this task, so the build resolves); `npm run e2e` exits 0 (skips printed by name); `SHOT_DIR=.nuke/2026-09-06-225118-spec-website/shots SHOT_TAG=p1 npm run shots` exits 0 and writes `p1-1440.png`, `p1-fold.png`, `p1-390.png`; `cat package.json | grep -A1 '"dependencies"'` shows an empty object; `wc -l` of every file ≤ 200.

**T-002 Skeleton, tokens, base.** Files: `website/index.html`, `website/src/main.ts`, `website/src/styles/main.css`, `website/src/styles/tokens.css`, `website/src/styles/base.css`, `website/src/styles/motion.css`.
The draft `index.html` and `src/styles/*.css` (moved there by T-001) come from the superseded plain-JS spec — keep what matches this spec, rewrite the rest. `index.html`: DESIGN §2 skeleton with **all** copy of §3, §4 (left column, claim, every diagram label, tick, route, rain, and card element as positioned elements with their text), §5 card, §8 table (five rows, caption, five visually hidden `scope="col"` headers `#`/`PLAN`/`IMPLEMENT`/`REVIEW`/`GOAL`, arrows are CSS `::after`, not cells), §9, §10 — real text, no placeholders; three `<canvas>` with `role/aria-label` and the §4 pixel `width`/`height`, each followed by an empty `<pre class="ghost-fallback" aria-hidden="true">` (filled in T-005); `<html lang="en" class="no-js">`; `<head>` per §1 (preconnects, one Google Fonts link with exactly `Bodoni+Moda:opsz,wght@6..96,400`, `JetBrains+Mono:wght@400;500`, `Space+Mono:wght@400`, `display=swap`), `<title>`, description, `theme-color`, viewport. `src/main.ts`: this phase is an empty module (the `no-js` → `js` swap is the inline head script per DESIGN §2). `tokens.css`: every §1 token. `base.css`: `@font-face` size-adjusted fallbacks for the three families, minimal reset, `body { background-color: var(--bg); background-image: var(--bg-vignette) }` + grain `body::after`, `::selection`, `:focus-visible` ring, `.dash`, `.rule`, `.rule--short`, `.visually-hidden`, `.no-js canvas` / `.js .ghost-fallback` hidden. `main.css`: `@layer tokens, base, layout, sections, motion;` then `@import url(...) layer(...)` for the files that exist (later phases append lines). `motion.css`: only the `@media (prefers-reduced-motion: reduce)` block for now.
Accept: `grep -c '<h1' website/index.html` = 1; `grep -c 'fonts.gstatic.com' website/index.html` ≥ 1; `grep -c 'display=swap' website/index.html` = 1; `grep -E -l '#[0-9a-fA-F]{3,8}' website/src/styles/*.css` prints only `website/src/styles/tokens.css`; `grep -ci 'orch' website/index.html` = 0; `grep -c '<tr' website/index.html` = 6; `ls website/styles website/js 2>&1` reports no such directory for both; in `website/`: `npm run typecheck && npm run lint && npm run build && npm run e2e` exit 0; via chrome-devtools on `http://localhost:4173`, `document.fonts.check('16px "Bodoni Moda"')` is `true`, `getComputedStyle(document.body).backgroundColor` is `rgb(11, 12, 14)` and `backgroundImage` contains `radial-gradient`; `shots/p1-1440.png` re-shot after this task.

## Phase 2 — Nav + hero left column

### Batch 2.A (one implementer, fable)

**T-003 Nav and hero left column.** Files: `website/src/styles/nav.css`, `website/src/styles/hero.css`, `website/src/features/copy-button.ts`, `website/src/features/copy-button.test.ts`, `website/src/main.ts` (wire `mountCopyButton` only), `website/src/styles/main.css` (two `@import` lines), `website/index.html` (class hooks only, no copy changes).
Implement DESIGN §3 and §4 left column + top-right claim exactly: 12-column grid, y-positions table, headline four lines with the muted second line and stanza gap, lede with `<strong>`, the CTA as a built `<button>` with the two-square copy glyph and clipboard behaviour (§4 CTA, REQ-018), works-with list, steps with the vertical hairline, the `/` drafting mark. The right column reserves its 7/12 with the `.diagram` box at `aspect-ratio: 760/860` (content comes in Phase 3). `copy-button.ts` exports `mountCopyButton(button: HTMLButtonElement, clipboard = navigator.clipboard)`; the test drives the 1.6 s swap with `vi.useFakeTimers()` and a fake clipboard object.
Accept: `shots/p2-fold.png` shows nav + steps + headline + lede + CTA within 1440×900 (CTA fully visible above the fold); headline cap-height of `TWO MODELS` measures ≥ 4× the lede x-height on the PNG; the critic's geometry check of the five left-column y-positions against §4 is within ±24px each; `npm test` includes ≥ 3 passing `copy-button` tests; clicking the CTA in chrome-devtools (`mcp__chrome-devtools__click`) changes its text to `copied to clipboard`; `grep -c 'aria-live' website/index.html` = 1; all gates green.

## Phase 3 — The diagram, static

### Batch 3.A (one implementer, fable)

**T-004 Noise, seats, silhouette, density, atlas, ghost + tests.** Files: `website/src/lib/noise.ts`, `website/src/lib/noise.test.ts`, `website/src/lib/reduced-motion.ts`, `website/src/features/diagram/seats.ts`, `website/src/features/diagram/silhouette.ts`, `website/src/features/diagram/silhouette.test.ts`, `website/src/features/diagram/density.ts`, `website/src/features/diagram/density.test.ts`, `website/src/features/diagram/atlas.ts`, `website/src/features/diagram/atlas.test.ts`, `website/src/features/diagram/ghost.ts`.
Remove `--passWithNoTests` from the `test` script in this task (tests exist from here on). Each file per DESIGN §13 and the algorithm in §6, exactly: `hash`/`valueNoise` (integer-mixing, deterministic); `seats.ts` = the config table (`planner` blue 30×25 P 6.5 F 6 phase 0 glitch 160ms · `implementer` green 26×22 P 2.8 F 12 phase 2.1 glitch 90ms · `reviewer` mixed 22×18 P 9 F 4 phase 4.2 no glitch ×0.7) typed as `Seat`; `silhouette.ts` `inside(u, v)`, `eye(u, v)`, `pupilCell(seat)`; `density.ts` `density(seat, c, r, t)` with base, banding, edge falloff, breath, noise, halo, reviewer factor; `atlas.ts` `GLYPHS`, `glyphFor(d)`, `colourFor(seat, d, sparkHash)`, `buildAtlas(seat, dpr)` (creates and returns its own offscreen canvas); `ghost.ts` `createGhost({ canvas, seat })` → `{ renderFrame(t), start(), stop() }` with the fixed-tick rAF loop, `IntersectionObserver` + `visibilitychange` pause, reduced-motion frame 0 via `lib/reduced-motion`. Tests: silhouette left-right symmetric; eye cells void; exactly one pupil per eye at the §6 offset; the planner's last row has ≥ 4 runs of inside cells; `glyphFor` covers all nine glyphs and clamps; `density` deterministic and within [0,1]; `valueNoise` continuous (neighbouring samples differ < 0.35); `hash` uniform-ish (10 000 samples, every decile 8–12%).
Accept: `npm test` passes with ≥ 10 tests; `wc -l` of every new file ≤ 200; `grep -c 'drawImage' website/src/features/diagram/ghost.ts` ≥ 1 (atlas path); all gates green (including the cross-feature-import and `Math.random` rows).

### Batch 3.B (one implementer, fable — runs after 3.A)

**T-005 Diagram layout, card, routes, labels, scatter, mount, fallbacks.** Files: `website/src/styles/diagram.css`, `website/src/features/diagram/scatter.ts`, `website/src/features/diagram/scatter.test.ts`, `website/src/features/diagram/mount.ts`, `website/src/main.ts` (wire `mountDiagram`), `website/src/styles/main.css` (one `@import`), `website/tools/render-static.ts`, `website/index.html` (fallback `<pre>` contents + class hooks).
Implement DESIGN §4 right column and §5: the 760×860 stage with `transform: scale()` fitting, every element at its `(x%, y%)` (use the quoted rims for routes A/B/C), the three dashed routes as absolutely positioned 1px elements (horizontal/vertical segments, hard corners), ticks + labels, seat labels, `+` mark, rain columns (static this phase), scatter band + halos from `scatter.ts` (seeded), the brief card with its six lines occluding the route. `mount.ts` `mountDiagram(root)` mounts the three ghosts (`renderFrame(0)` only — `start()` comes in Phase 4) and the scatter. `render-static.ts` prints each seat's frame-0 grid; paste the output into the three `<pre class="ghost-fallback">` elements.
Accept: `shots/p3-1440.png` shows three ghosts with visible eye voids, the card reading `tasks.md` / `TASK BRIEF` / three T-rows, three dashed routes meeting the card, all nine labels; the critic measures each §4 element within ±3% of its coordinate; `grep -c 'class="ghost-fallback"' website/index.html` = 3 and each contains ≥ 18 non-empty lines; `npm test` includes ≥ 2 `scatter` tests; all gates green.

## Phase 4 — Motion

### Batch 4.A (one implementer, fable)

**T-006 Breath, rain, packets, entrance, fragments.** Files: `website/src/features/diagram/packet.ts`, `website/src/features/diagram/mount.ts` (start loops + packets), `website/src/features/fragments/pool.ts`, `website/src/features/fragments/mount.ts`, `website/src/features/fragments/mount.test.ts`, `website/src/main.ts` (wire `mountFragments`), `website/src/styles/motion.css`, `website/src/styles/diagram.css` (rain keyframes hook only), `website/tests/e2e/motion.e2e.ts`, `website/tests/e2e/shots.e2e.ts` (only if the seek helper needs the animation names).
The owner's bar for this phase (2026-09-07): the ghosts and the whole page must *feel* alive and designed — "zajebiste animacje" — not merely comply with §7. GSAP (core, and a plugin only if needed) is allowed when a native timeline would be clumsy; native CSS/WAAPI is preferred where it is clean. Add to §7 only within its one concept (the system is alive and routing): e.g. the packet leaving a fading dotted wake, the ghost's rim cells lifting a beat before the packet arrives, eye pupils tracking the packet, a subtle glyph-cascade on the card when a task row flips — every addition named in the hand-back and reflected in DESIGN §7 by the implementer (the sheet stays the source of truth). Carried craft items from the Phase 3 critic (apply first, record in §6/§4): crown apex — the top two crown rows render as `.`/`:` (edge falloff ×0.45 on the lowest base) → raise `CORE.ry` 0.7→~0.85 or floor crown-row density at 0.5 and use ×0.6 edge falloff for crown rows; halo fog — `0.08 + 0.1n` lights ~55% of the 2-cell ring → `0.05 + 0.1n` and reach 2 only on the inner ring; rain bottom share 12% → ~20% so the funnel is perceptible statically. DESIGN §7 in full: start the ghost loops (breath + glitch schedule), rain drift (the seeded glyph columns from `rain.ts` drift downward at 14px/s and re-seed at the top — not a `background-position` shift), the shared 9 s timeline for the two packets (`.packet--impl` on routes A+B, `.packet--rev` on route C) on `offset-path` over the exact route polylines with the card row / tick label brightening at the specified moments, the load entrance stagger, and the 28 fixed-layer fragments hovering 120px, origins/durations/opacities drawn from `lib/noise` with a fixed seed, with the exclusion test over origin + travel band (headline, lede, CTA) and the ≤ .35 opacity cap; `mount.test.ts` covers the exclusion and the same-seed determinism. Reduced motion: every item off per §7's last paragraph — verified both by the CSS media block and by `lib/reduced-motion` in `main.ts` (subscribe to `change`). `motion.e2e.ts` per §13: reduced motion via `test.use({ reducedMotion: 'reduce' })`; CSS animations seeked with `document.getAnimations()` (pause + `currentTime`), ghost loops with `page.clock`.
Accept: `npm run e2e` passes including `motion.e2e.ts` (reduced-motion frames identical; default frames differ; packet on route B at animation time 2.6 s; no fragment/headline intersection at 0/10/20/30 s); three captures `SHOT_TIME_MS=500` (`p4a`), `2600` (`p4b`), `4500` (`p4c`) — the critic confirms `p4a`/`p4c` differ in the ghost regions and `p4b` shows `.packet--impl` on route B; `grep -c 'offset-path' website/src/features/diagram/packet.ts website/src/styles/motion.css` ≥ 1; `grep -c 'prefers-reduced-motion' website/src/styles/motion.css website/src/lib/reduced-motion.ts` ≥ 2; `page.e2e.ts` JS-budget assertion updated to the gzipped budgets (≤ 90 KB total, ≤ 12 KB own code, measured on served bytes with `Accept-Encoding: gzip` or by gzipping the bodies in-test) and passing; no fragment overlaps the headline/lede/CTA in `p4a-fold.png`; all gates green.

## Phase 5 — Routes, manifesto, footer

### Batch 5.A (one implementer, fable)

**T-007 Lower sections.** Files: `website/src/styles/routes.css`, `website/src/styles/manifesto.css`, `website/src/styles/footer.css`, `website/src/styles/main.css` (three `@import`s), `website/index.html` (class hooks only), `website/tests/e2e/page.e2e.ts` (un-skip the table assertion).
DESIGN §8, §9, §10: the routes table typography and column rhythm (arrows as `::after`, comment column, `°` marks, visually hidden headers), the right claim; the manifesto three-column breath with the Space Mono heading and the ordered list; the short rule and the three-column footer with the centred tick and repo link.
Accept: on `shots/p5-1440.png` the manifesto section's rendered height (rule to rule) is ≥ 1.5× the routes table's row band — measured via `evaluate_script` `getBoundingClientRect()` on `.manifesto` and `.routes tbody`; routes row pitch 26px ±2 (`tbody tr` rect heights); `grep -c '<tr' website/index.html` = 6; `grep -c 'github.com/b4r7x/splitbrief' website/index.html` ≥ 2; `page.e2e.ts` table assertion un-skipped and passing; all gates green.

## Phase 6 — Responsive, floor, craft pass

### Batch 6.A (one implementer, fable)

**T-008 Responsive tiers, a11y floor, craft pass.** Files: any under `website/` (integration pass; still one concern per edit, still ≤ 200 lines per file, still no cross-feature imports).
DESIGN §11 (768–1099 and < 768 tiers, the compact vertical diagram stage via container query, table stacking, works-with two columns), §12 floor (focus rings, touch targets, contrast, `text-wrap`, tabular nums, `overflow-wrap` on the footer link only), then the nuke-design craft pass at zoom over marks, wraps, alignment, `::selection`, focus, the fallbacks.
Accept: `shots/p6-390.png` shows the compact vertical stage with legible ghosts (7×11 cell grid, fit-scale 1.0 at 390) and stacked route rows; `page.e2e.ts` overflow assertions pass at 390 and 360 (paste the run); Lighthouse via `mcp__chrome-devtools__lighthouse_audit` on `http://localhost:4173/` — accessibility ≥ 95 and performance ≥ 95 (paste scores); every gate green with outputs pasted; the hand-back contains a `craft pass:` line and a tell-walk with zero hits or an honest list and a score.

## Coverage map

REQ-001 → all (validator checks `git status`) · REQ-002 → T-002 · REQ-003 → T-002, T-005, T-007 · REQ-004 → T-002 · REQ-005 → T-002 · REQ-006 → T-003, T-005 · REQ-007 → T-004 · REQ-008 → T-006 · REQ-009 → T-006 · REQ-010 → T-006 · REQ-011 → T-002, T-007 · REQ-012 → T-007 · REQ-013 → T-008 · REQ-014 → T-002, T-003, T-008 · REQ-015 → T-001, T-006 · REQ-016 → T-001, T-006 · REQ-017 → all · REQ-018 → T-003 · REQ-019 → T-005 · REQ-020 → every phase's critic · REQ-021 → T-009, T-010, Phase 8.

## Execution protocol

1. One implementer per batch, sequential. It loads the skill map for its file types, pulls current docs via context7 for any tool config it writes, reads DESIGN.md whole, does the task, shoots, critiques (three worst things first), fixes, re-shoots, and hands back: files changed with line refs, screenshot paths, its critique, `craft pass:` line, tell-walk with score, gate outputs verbatim.
2. A fresh fable critic per phase receives DESIGN.md, the task text, `reference.png`, and the screenshots — never the implementer's reasoning — and returns per-item `earned | missed` with concrete fixes, the three worst things in the render, the nuke-design tell-walk, a structure check against DESIGN §13 (file names, sizes, imports), and a 1–10 score. A phase is done only at ≥ 8/10 with zero `missed` on its own surface; the orchestrator opens the fold screenshot itself before marking a phase done.
3. `missed` or a tell → one fix implementer with the critic's list → re-shoot → re-critique. Cap 2 cycles per phase; on cap, record the open items in `exec-progress.md` and continue only if the open items are not on the phase's own surface.
4. Update `exec-progress.md` after every cycle; it is the resume point for any later session.

## Phase 7 — Extension research + design addendum (added 2026-09-07 00:20, owner's instruction)

### Batch 7.A (one researcher, fable)

**T-009 Product research → section proposals.** Files: `.nuke/2026-09-06-225118-spec-website/extension-research.md` (new; nothing under `website/`).
Read `README.md`, `docs/MENTAL-MODEL.md`, `docs/HOW-IT-WORKS.md`, `docs/WORKFLOW.md`, `docs/APPROVAL-AND-RECOVERY.md`, `docs/PLANNERS-AND-IMPLEMENTERS.md`, `docs/VISION.md`, `docs/CLI-REFERENCE.md`, `docs/TASK-CONTRACT.md` if present, and run `npm run tui-shots -- --list` then render 3–5 gallery scenarios (`npm run tui-shots -- --scenario <id>`) to see the real TUI (PNGs under `.test-artifacts/ui/`). Produce: (a) an inventory of product substance the current page (DESIGN §3–§10) leaves out, each line with the doc quote that backs it; (b) 4–6 candidate sections, each with: the claim it makes, the real artefact that proves it (a brief excerpt, the validation ladder, a session folder tree, a TUI capture), a one-line composition idea inside the sheet's direction, and a cut/keep recommendation; (c) the recommended set (≤ 3 sections) with the order they slot into the page and why the others were cut. No copy that the docs cannot back. No feature-card grids.
Accept: file exists, every inventory line carries a `docs/…:` or `README.md:` citation; ≤ 3 recommended sections; the TUI PNG paths listed.

### Batch 7.B (one designer, fable — after 7.A)

**T-010 Design addendum.** Files: `website/DESIGN.md` (append `## 15. Extension` with the same rigour as §3–§10: per-section geometry, copy verbatim, tokens used, motion within §7's concept, responsive tiers, e2e assertions), `.nuke/2026-09-06-225118-spec-website/spec.md` (append Phase 8 with T-011.. tasks, Accept lines, coverage map lines for REQ-021).
Accept: §15 exists with copy for every new string, every new coordinate inside 0–100%, no new token outside §1 (or §1 extended with a justification line); Phase 8 tasks each ≤ 5 files, Accept lines mechanically checkable; the opus spec reviewer returns ACCEPT on the addendum (cap 2 cycles).

## Phase 8 — Extension build (tasks appended by T-010)
