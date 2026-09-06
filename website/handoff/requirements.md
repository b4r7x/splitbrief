# Requirements — SPLITBRIEF website

Source: `.nuke/website-prompt.md` (orch → splitbrief), `reference.png`, README.md, docs/MENTAL-MODEL.md, docs/VISION.md, clarification answers in `plan.md`. Design detail lives in `website/DESIGN.md` (the sheet is part of the contract; section numbers below refer to it).

## Requirements

- REQ-001 The site lives entirely under `website/`; nothing outside it changes. `git status --porcelain` shows only `website/` paths.
- REQ-002 `website/` is a self-contained Vite + TypeScript package: `npm ci && npm run build` produces `dist/` with the complete page; `dependencies` holds at most `gsap` (no UI framework); `base: './'` keeps `dist/` deployable under any path.
- REQ-003 Every string of copy on the page equals DESIGN.md §3, §4, §5, §8, §9, §10 verbatim (wordmark `splitbrief°`, tagline, steps, claim, headline, lede, CTA, works-with, diagram labels, card, routes rows, manifesto, footer). No "orch" anywhere in `website/` except this sentence's source files.
- REQ-004 Fonts load from Google Fonts with `preconnect` to both hosts, `display=swap`, exactly the three families and weights in §1, and each family has a size-adjusted local fallback `@font-face`.
- REQ-005 All colours, fonts, and spacing are custom properties in `styles/tokens.css`; no other stylesheet contains a hex colour, a font-family name, or a pixel spacing value outside the §1 scale — except geometry DESIGN §3–§11 declares literally (cell grid, tick lengths, row pitches, card and CTA boxes, the 760×860 / 350×980 stages).
- REQ-006 At 1440 wide the hero is a 12-column grid, left column cols 1–5, diagram cols 6–12, and every diagram element sits within ±3% of its §4 coordinate (measured on the screenshot).
- REQ-007 Three ghost canvases render the §6 silhouette on a locked 7×11 cell grid via a prerendered glyph atlas; rendering is deterministic (same seed + t → identical grid); the pure functions (silhouette, density, ramp, noise, scatter placement) are unit-tested with Vitest, colocated.
- REQ-008 Motion is exactly the five items of §7 and nothing else; `prefers-reduced-motion: reduce` yields frame 0 only, no packet, static fragments, instant entrance (CSS media query + `matchMedia` in JS), asserted by `motion.e2e.ts` under `test.use({ reducedMotion: 'reduce' })`.
- REQ-009 Both packets (`.packet--impl` on routes A+B, `.packet--rev` on route C) travel their drawn polylines via `offset-path` and stay glued to the lines when the stage is scaled.
- REQ-010 Background fragments come from the §7.5 pool, are placed deterministically from a fixed seed via `lib/noise`, never overlap the headline, lede, or CTA bounding boxes, and never exceed opacity .35.
- REQ-011 The routes section is a semantic `<table>` (caption, `scope="col"` headers) with exactly the five §8 rows.
- REQ-012 The manifesto and footer match §9 and §10 (three-column grid, wide face heading, ordered list, footer link to the repo).
- REQ-013 Responsive tiers per §11: at 390 wide there is no horizontal scroll (`document.scrollWidth ≤ 390`), the diagram uses the compact vertical stage, and the ghost cell grid stays 7×11 CSS px before the stage's uniform fit-scale (1.0 at 390).
- REQ-014 Accessibility floor: `<html lang="en">`, one `<h1>`, `<title>` and `<meta name="description">` per §12, every canvas has `role="img"` + `aria-label`, every link has an `href`, focus rings visible (2px), text tokens meet AA (`--ink-3` against the vignette's lightest stop `#101216` ≥ 4.5:1), CTA and links ≥ 44px touch targets.
- REQ-015 The e2e run records zero console errors; the built JS in `dist/assets/` totals ≤ 90 KB gzipped, of which our own code ≤ 12 KB gzipped (asserted by `page.e2e.ts` on the served, compressed bytes).
- REQ-016 Tooling: `npm run shots` (Playwright, system Chrome) writes `<SHOT_TAG>-1440.png`, `-fold.png`, `-390.png` into `SHOT_DIR`; `npm run e2e` runs `tests/e2e/page.e2e.ts` and `motion.e2e.ts`; `npm run typecheck`, `npm run lint`, `npm test` exist and pass. Focus rings, touch targets, and the mobile cell size are the T-008 critic's checks.
- REQ-017 Structure per §13 and sota-structure: TypeScript strict; behaviour features under `src/features/` (flat file below 3 files, folder at 3+), stylesheets in `src/styles/`, shared code in `src/lib/` only on a second consumer; kebab-case; basename = primary export with no path-echo; no `utils`/`helpers` grab-bags; no `index.ts` barrels; colocated `*.test.ts`; e2e under `tests/e2e/*.e2e.ts`; every file ≤ 200 lines; features never import each other.
- REQ-018 The CTA copies `npm install -g splitbrief` to the clipboard and announces `copied to clipboard` in a polite live region for 1.6 s.
- REQ-019 With JS disabled (`html.no-js`), each ghost's `<pre class="ghost-fallback" aria-hidden="true">` shows the frame-0 character art produced by `tools/render-static.ts` and the canvas is hidden; with JS the `<pre>` is hidden. Reduced motion keeps the canvas at frame 0.
- REQ-021 (extension, added 2026-09-07 00:20 by the owner) After Phases 1–6 are done and verified, the page is extended with the product substance the current sections leave out — drawn from the repo's own docs (`docs/MENTAL-MODEL.md`, `HOW-IT-WORKS.md`, `WORKFLOW.md`, `APPROVAL-AND-RECOVERY.md`, `PLANNERS-AND-IMPLEMENTERS.md`, `VISION.md`, `CLI-REFERENCE.md`, README) and the real TUI (`npm run tui-shots`) — designed as an addendum to this sheet (same brief, same tokens, same motion concept) and built through the same phase loop. Candidates the research phase must weigh: the Task Brief contract, the validation → retry → escalation ladder, the evidence trail, modes, runner kinds, a real TUI moment as proof. Restraint holds: fewer, stronger sections; no feature-card grid.
- REQ-020 Every build phase hands back screenshots at 1440-full, 1440-fold, 390-full, a written critique against `reference.png`, a `craft pass:` line, and a tell-walk result; a fresh critic must return `earned` on the phase surface before the phase is marked done.

## Non-goals

- Deployment (Pages/Vercel config), analytics, SEO beyond title/description, OpenGraph image.
- A light theme or theme toggle. The page is dark only.
- Docs pages, blog, changelog, pricing, a mobile menu, an "x" link.
- Changes to the root README, docs, or CLI code.
- Pixel-identical reproduction of the reference; the target is the same composition and craft with SPLITBRIEF copy.

## Constraints

- Never `git add` / `git commit` / `git stage` (repo rule; hook enforces).
- Playwright with `channel: 'chrome'` (the installed Google Chrome 152) is the render tool; no browser download.
- One implementer at a time (user's usage window). Fable for every visual phase; opus only for non-visual chores.
- Skills every implementer loads: `sota-structure`, `typescript-best-practices`, `nuke-design` (build half), `nuke-creative` (as charter), `nuke-lean`, `frontend-design`, `web-design-guidelines`, `clean-code`; e2e work adds `webapp-testing` and `test-behavior-not-implementation`. Critics load `nuke-design` (verification half) + `nuke-creative`.
- Current docs via context7 before writing any Vite / Vitest / Playwright / Biome config — never from memory.

## Design

See `website/DESIGN.md` §1–§14 — tokens, skeleton, per-section geometry and copy, ghost algorithm, motion concept, responsive tiers, craft floor, file map, verification protocol.

## Decisions

- Decision: ghosts are canvas-rendered from a density field with a glyph atlas. Rejected: hand-drawn `<pre>` ASCII — cannot breathe without re-typing every frame, and two artists would draw two different ghosts.
- Decision: the packet uses CSS `offset-path` over the same polyline as the drawn route. Rejected: JS-interpolated `left/top` — drifts off the line under `transform: scale()` and costs a rAF loop.
- Decision: the diagram is a fixed 760×860 stage scaled by `transform`. Rejected: fluid percent layout of the canvases — the cell grid would reflow and the character art would blur (wordmark/ASCII lock rule).
- Decision: mobile gets a compact vertical stage, not a scaled-down desktop stage. Rejected: `scale(.47)` — 3px cells are illegible; the signature would read as noise.
- Decision: the hero artifact is `tasks.md` labelled TASK BRIEF. Rejected: `plan.md` — exists as a session artifact but is not the contract SPLITBRIEF is named for.
- Decision: the 9-dot mark is a static ornament, not a button. Rejected: a menu button — there is no menu; a control that does nothing is a lie.
- Decision: `[ SCROLL ]` from the reference becomes the repo link in the footer. Rejected: keeping it — a scroll cue at the page bottom points at nothing.
- Decision: wide manifesto face is Space Mono. Rejected: Silkscreen/VT323 pixel fonts — read as a toy; the reference's face is a wide geometric mono, not a bitmap.
- Decision: `°` is a running motif meaning "the seat that signs off" (wordmark, reviewer label, review column). Rejected: `°` on the wordmark only — leaves the reference's `gpt-5.6°` unexplained.
- Decision: `website/` is its own Vite + TypeScript package with Vitest, Playwright, and Biome; the root has no workspaces, so it is simply a sibling package (the user asked for it separate from the CLI build). Rejected (superseded 2026-09-06 23:20): a zero-build plain-JS folder with shell/`.mjs` tools — it reinvented an HTML parser and an overflow probe that Playwright gives for free, and it is not TypeScript.
- Decision: Playwright uses `channel: 'chrome'`. Rejected: bundled Chromium — a 150 MB download for no gain when Chrome 152 is installed.
- Decision: unit tests cover pure modules only (`environment: 'node'`); DOM behaviour is e2e-tested. Rejected: jsdom unit tests of canvas/DOM code — canvas is a stub in jsdom, so those tests would assert nothing.
- Decision: the ghost pipeline is four files by responsibility (`silhouette`, `density`, `atlas`, `ghost`), each ≤ 120 lines. Rejected: one 260-line `ghost.ts` — three concerns in one file.
