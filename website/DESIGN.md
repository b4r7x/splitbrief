# SPLITBRIEF website — design sheet

The single source of truth for `website/`. Every implementer reads this whole file before touching a line. The visual target is `.nuke/2026-09-06-225118-spec-website/reference.png` (an "orch" comp, 1024×1536); this sheet translates it to SPLITBRIEF and to a 1440-wide frame. Where the sheet and the reference disagree, the sheet wins (copy is product-true; geometry follows the reference).

## 0. Brief (nuke-creative)

- **Audience:** developers who already run Claude Code / Codex / OpenCode and are skeptical of "AI startup" pages. They judge in 3 seconds and read the small print.
- **Feel:** precise · quiet · slightly haunted. Editorial restraint, terminal-native detail.
- **Reference point:** late-issue print typography (Didone display + tiny mono annotations) laid over a dark terminal — the reference comp, not a "cyberpunk" page.
- **Constraints:** one static page, TypeScript, Vite build to `dist/`, no UI framework. Runtime dependencies only for motion and only when they earn it (GSAP core + a plugin is allowed for the §7 concept when native CSS/WAAPI cannot express a timeline cleanly; nothing else). Google Fonts CDN. WCAG AA for all body/label text (labels at ≥ 4.5:1 on the canvas; decorative particles exempt). `prefers-reduced-motion` honoured everywhere. No image assets — the ghosts are rendered from characters.
- **Direction (chosen):** `editorial + technical`. Type pairing: **Bodoni Moda** (display — a true Didone with an optical-size axis; chosen over Instrument Serif on 2026-09-07 after an A/B against the reference: 23:1 stroke contrast vs 2.6:1, letter width 8.7× cap vs 6.6×, fits the 5-column measure without overflow) + **JetBrains Mono** (labels, body) + **Space Mono** (the wide lower manifesto face). Palette: canvas near-black tinted cold, off-white ink, **two accents only — blue (planner) and green (implementer)**. Layout stance: an asymmetric hero — 5/12 type column, 7/12 diagram, headline larger than anything else, small caps annotations pinned to the corners like a technical drawing. Signature element: **three ASCII ghost daemons routed through one `tasks.md` card** — living character fields, not an illustration.
- **Runner-up (recorded):** `brutalist` — raw mono everywhere, no serif. Rejected: loses the print tension that makes the reference memorable.
- **Anti-default gate:** no Inter/system-ui; no blue-purple gradient; no centered hero; no three-card grid; no glassmorphism; no emoji; no gradient blobs; no bento; one motion concept (§7); reduced motion respected.

## 1. Tokens

All in `src/styles/tokens.css` as custom properties on `:root`. No other file declares a raw colour, font, or spacing value.

### Colour

| token | value | use |
|---|---|---|
| `--bg` | `#0b0c0e` | canvas (never `#000`; cold tint) |
| `--bg-vignette` | `radial-gradient(120% 90% at 60% 20%, #101216 0%, #0b0c0e 55%, #08090a 100%)` | body background — the one atmosphere element |
| `--ink` | `#ece9e2` | headline, primary text |
| `--ink-2` | `#b9b6ae` | body copy (≥ 7:1 on bg) |
| `--ink-3` | `#84827c` | labels, eyebrows, comments (4.6:1 against the vignette's lightest stop `#101216` — the AA floor for small text; `page.e2e.ts` measures against that stop, not `--bg`) |
| `--ink-4` | `#4a4946` | ghost headline line ("ARE GOOD."), decorative only |
| `--hair` | `rgb(255 255 255 / .12)` | rules, box borders |
| `--hair-strong` | `rgb(255 255 255 / .22)` | CTA box border, focus ring base |
| `--blue` | `#6e97ea` | planner accent (labels, ghost, route) |
| `--blue-dim` | `#3a5aa0` | planner ghost low-density cells |
| `--green` | `#58c48f` | implementer accent |
| `--green-dim` | `#2f7a58` | implementer ghost low-density cells |
| `--white-spark` | `#f4f2ec` | 12% of ghost cells and the route packet |
| `--focus` | `#6e97ea` | focus ring (2px solid, offset 3px) |
| `--selection` | `rgb(110 151 234 / .35)` | `::selection` |

Reviewer ghost: mixed cells — 55% blue-dim, 35% green-dim, 10% spark — it belongs to neither lab.

### Type

| token | value |
|---|---|
| `--font-display` | `"Bodoni Moda", "Bodoni Moda Fallback", Georgia, "Times New Roman", serif` — `font-optical-sizing: none; font-variation-settings: "opsz" 20` — chosen by measuring the O's top hairline of `TWO MODELS` at 1440 / DPR 1 (77.76px, cap 58px) as % of cap: opsz 48 → 0.84%, 60 → 0.73%, 72 → 0.64% (all under the 1.5–3% window), 36 → 0.87%, 24 → 1.44%, **20 → 1.66% (0.96px; 1.71% at DPR 2)**, 16 → 1.96%; the reference itself measures 1.23% with width/cap 8.85 — opsz 20 gives 8.88 |
| `--font-mono` | `"JetBrains Mono", "JetBrains Mono Fallback", ui-monospace, "SF Mono", Menlo, monospace` |
| `--font-wide` | `"Space Mono", "Space Mono Fallback", ui-monospace, monospace` |
| `--text-display` | `clamp(3.25rem, 5.4vw, 4.9rem)` — 52→78.4px (77.76px at 1440, cap ≈ 58px; the reference implies 65); line-height `1`; letter-spacing `0`; weight 400; `TWO MODELS` must fit the 5-column measure (533px at 1440) with no `nowrap` masking — measured 519.9px at opsz 20; the 4.9rem ceiling keeps it inside the column above 1450px (at 84px it measures 549px) and 5.4vw keeps ≥ 9px of margin down to the 1100px tier edge; below 768 the token is `clamp(2.75rem, 13vw, 3.25rem)` (one media block in tokens.css) — `TWO MODELS` is 6.686× the font size, so the 3.25rem floor (347.7 px) fits the 350 px column at 390 but wraps in the 320 px column at 360; 13vw renders 50.7 px / 339 px at 390 and 46.8 px / 313 px at 360 (measured 2026-09-08, Phase 6) |
| `--text-wide` | `clamp(1.375rem, 2.1vw, 1.9rem)` — the "// YOU DESCRIBE" block; line-height `1.25`; letter-spacing `.04em` |
| `--text-body` | `.9375rem` (15px); line-height `1.6` — hero paragraph, manifesto paragraph |
| `--text-label` | `.75rem` (12px); line-height `1.45`; letter-spacing `.08em`; uppercase — every annotation, nav link, step, works-with, list |
| `--text-micro` | `.6875rem` (11px) — diagram side labels, brief card body, footer |
| `--text-cta` | `.875rem` (14px) — the install line |

Fonts load from Google Fonts: `Bodoni+Moda:opsz,wght@6..96,400`, `JetBrains+Mono:wght@400;500`, `Space+Mono:wght@400` with `display=swap`, `<link rel="preconnect">` to `fonts.googleapis.com` and `fonts.gstatic.com` (`crossorigin`). Each family gets a size-adjusted local fallback `@font-face` (`size-adjust`, `ascent-override`, `descent-override`) so the swap does not shift layout; the metrics are calibrated by measuring the real face against the fallback on the strings the page actually sets (the display face is calibrated on the uppercase h1 against Georgia; re-measured after every face change and recorded in base.css). Headings `text-wrap: balance`; paragraphs `text-wrap: pretty`; numeric columns `font-variant-numeric: tabular-nums`.

### Space & grid

- Scale: `--s-1: 4px · --s-2: 8px · --s-3: 12px · --s-4: 16px · --s-6: 24px · --s-8: 32px · --s-12: 48px · --s-16: 64px · --s-24: 96px · --s-32: 128px`. No other values.
- Page gutter `--gutter: clamp(20px, 4.4vw, 64px)`. Content max-width `1312px` (1440 − 2×64), centred.
- Grid: 12 columns, `column-gap: var(--s-6)`. Hero left = cols 1–5, hero diagram = cols 6–12. Routes table spans 1–9, its claim sits in 11–12. Manifesto: heading 1–4, paragraph 5–9, list 11–12. Footer: 1–3 / 5–8 / 11–12. One right rail: every claim below the hero starts on the hero claim's column (11, §4), so the four right-column x's are equal at 1440 (measured 2026-09-08, fix cycle 1: at col 10 they stepped 111 px left of the hero claim).
- Section gap `--s-24` (96px); the manifesto is the breath: `--s-32` above and below. The hero→routes seam is the one seam with a rule in it and runs tighter: hero `padding-bottom --s-12` + hairline + routes `padding-top --s-16` = 113 px, so the rule sits 48 px under the works-with dash instead of floating in 161 px of bare canvas (64 + 97 measured 2026-09-08, fix cycle 1; the reference, scaled, is 42 / 67).
- Rules: 1px `--hair`. The dash ornament `—` (an 18px×1px `--ink-3` line, `.dash`) closes every annotation block; it is the running motif together with the `°` mark and the `[ ]` brackets.

### Surfaces

One surface system: **hairline borders, no shadows, no radius** (`border-radius: 0` everywhere). The only boxes on the page are the CTA and the `tasks.md` card; both are 1px `--hair-strong` on transparent, with an inset 1px top highlight `inset 0 1px 0 rgb(255 255 255 / .05)`. Grain: an SVG `feTurbulence` overlay on `body::after`, opacity `.06` (the nuke-design cap — at `.045` it measured invisible on this canvas), `pointer-events: none`, `mix-blend-mode: overlay`.

## 2. Page skeleton (top → bottom)

```
<header class="nav">            wordmark · tagline · links · 9-dot mark
<main>
  <section class="hero">        steps · claim · headline · lede · cta · works-with  |  diagram
  <hr class="rule">
  <section class="routes">      eyebrow · 5 rows · claim
  <section class="brief-sheet"> eyebrow · claim · tasks.md sheet (cropped) · two marginalia statements   §15.1
  <hr class="rule">             the sheet's crop line
  <section class="manifesto">   wide heading · paragraph · 01–05 list
  <section class="ladder">      eyebrow · claim · run transcript · rungs · statements · small print   §15.2
  <section class="record">      eyebrow · claim · statement · .splitbrief/ tree · small print · two $ lines   §15.3
  <hr class="rule rule--short">
</main>
<footer class="foot">           left claim · centre tick + link · right claim
```

Semantic HTML: `header/nav/main/section/footer`, `h1` is the hero statement, `h2`s are visually the eyebrows (`EXAMPLE ROUTES`, the wide manifesto heading, and the three §15 eyebrows), the routes are a real `<table>` with `<caption>` (visually hidden) and `scope="col"` headers, the brief card is a `<figure>` with `<figcaption>`, the ghosts are `<canvas role="img" aria-label="…">`, each followed by a `<pre class="ghost-fallback" aria-hidden="true">` holding the same character art (frame 0, printed by `tools/render-static.ts`). `<html class="no-js">`; a one-line inline `<script>` in `<head>` (`document.documentElement.classList.replace('no-js','js')`) swaps the class before the body parses — module scripts defer, so doing it in `main.ts` would flash the `<pre>` fallbacks; `.no-js canvas` is hidden and `.js .ghost-fallback` is hidden, so exactly one of the pair renders. Reduced motion keeps the canvas (frame 0) — the `<pre>` is the no-JS path only.

## 3. Nav (`header.nav`)

Height 96px (padding-block `--s-8`). Four items on one row, baseline-aligned:

1. **Wordmark** `splitbrief°` — `--font-mono`, 22px, weight 500, `--ink`; the `°` is a `<sup>` in `--ink-3` at 60% size, `top: -.6em`. Links to `#top`.
2. **Tagline** (cols 3–4, starts at ~col 3): three lines, `--text-label`, `--ink-3`: `ONE PLANS.` / `ONE EXECUTES.` / `ONE CONTRACT.`
3. **Links** (right-aligned, before the mark): `[ docs ]` → `https://github.com/b4r7x/splitbrief/tree/main/docs`, `[ github ]` → `https://github.com/b4r7x/splitbrief`. `--text-label`, `--ink-2`; brackets are part of the text; hover: brackets turn `--blue`, text `--ink`; `text-decoration: none`; visible focus ring.
4. **9-dot mark** — a 3×3 grid of 3px dots, 20×20 box, `--ink-2`; pure ornament (`aria-hidden`, a `<span>`, not a button). Sits at the right gutter.

## 4. Hero (`section.hero`)

Grid 12 columns; `min-height: calc(100vh - 96px)`; `padding-block: var(--s-6) var(--s-12)` (the bottom pad is the hero→routes seam, §1).

### Left column (cols 1–5) — vertical order, five rows, with the y-positions the reference implies at 1440 (nav bottom = 0)

| y | element | spec |
|---|---|---|
| 24 | **Steps** | three rows: `01 │ PLAN`, `02 │ EXECUTE`, `03 │ REVIEW`. Number `--ink-3`, one continuous 1px `--hair` vertical rule spanning the three rows between number and label (`border-left` on the label cell, `padding-left: var(--s-3)`, number column 32px wide), label `--ink-2`. `--text-label`. Row pitch 18px. |
| 189 | **Headline** `h1` | margin-top `--s-24`; four lines, `--text-display`, `--font-display`: `TWO MODELS` / `ARE GOOD.` (this line `--ink-4`) / *stanza gap `--s-24`* / `A SYSTEM` / `IS BETTER.` Each line a `<span class="line">` (display block) so the muted line and the stanza gap are styleable; the h1 text reads "Two models are good. A system is better." to assistive tech (use `aria-label` on the h1 to avoid the visual line breaks being read as pauses). No uppercase transform — the source text is uppercase. |
| 624 | **Lede** `p` | four lines, `--text-body`, `--ink-2`, `max-width: 34rem`: `**splitbrief** runs two coding tools against one job — three when another lab reviews. The stronger one plans and reviews, the cheaper one executes — and splitbrief holds the contract between them.` — first word `<strong>` in `--ink`, weight 500. Closed by `.dash`. The `<br>` sits after `job —` (both dashes are glued to the word before them with `&nbsp;`, so no line opens on a dash), and the rag at 1440 is 51 / 58 / 56 / 26 characters — `text-wrap: pretty` carries `the` down to the last line. The `<br>` is hidden below 1250: there the five-column measure (44 characters at 1100) no longer holds the 51-character first clause and the forced break left `one job —` alone on a line; without it the lede sets in five lines from 1100 to 1249 and four from 768 up, no line shorter than two words (owner's copy, 2026-09-09 — three lines, `…against one job.`, until then). |
| 729 | **CTA** | a `<button class="cta" type="button">` `max-content` wide (≥ 264px) × 44px, both label states stacked in one grid cell so the width never changes on click: `$ npm install -g splitbrief` in `--text-cta`, `--ink`, the `$` in `--ink-3`; right-aligned 14px "two overlapping squares" copy glyph drawn with two 1px-bordered `<span>`s (no icon font, no emoji). Click → `navigator.clipboard.writeText('npm install -g splitbrief')`, the label swaps to `copied to clipboard` for 1.6s (live region `aria-live="polite"`), border flashes `--blue`. Hover: border `--ink-3`. Focus: ring. It is the most built thing in the column by design (nuke-design rule 6). |
| 821 | **Works with** | eyebrow `WORKS WITH` (`--ink-3`) then six lines `--text-label` `--ink-2`: `CLAUDE CODE` / `CODEX` / `OPENCODE` / `CURSOR` / `COPILOT · KILO CODE` / `OLLAMA · LM STUDIO`. Closed by `.dash`. |

### Top-right claim (cols 11–12, top of the hero, aligned with the steps row)

Three lines `--text-label`, right column but left-aligned text: `DIFFERENT LABS.` / `FEWER BLIND SPOTS.` / `REAL EVIDENCE.` — first two `--ink-2`, third `--ink`. Closed by `.dash`. A lone `/` glyph (`--ink-3`, 14px) sits 40px above-left of it as a drafting mark (matches the reference).

### Right column — the diagram (`.diagram`, cols 6–12)

A `position: relative` box **760 × 860px** at 1440 (`aspect-ratio: 760 / 860; width: 100%`), `overflow: hidden`. Inside it a fixed **760×860 stage** (`.stage`) carries every child at absolute `(x%, y%)` coordinates; the stage is scaled with `transform: scale(boxWidth / 760)` (`transform-origin: 0 0`) so the character grids never reflow (§6 lock rule). Coordinates below are `(x%, y%)` of the stage; anchor = element **centre** unless the row says top-left or top-anchored. Derived rims (for routes) are computed from centre ± half-size and quoted so the critic can measure them. The top-right hero claim (cols 11–12, which start at stage x ≈ 73%) overlays the stage's top-right corner; no stage element is placed at `x > 73%` with `y < 12%`.

| element | anchor | notes |
|---|---|---|
| **planner ghost** (canvas 210×275 = 30×25 cells) | centre (14%, 40%) → spans x 0.2–27.8%, y 24–56% | blue |
| **implementer ghost** (canvas 182×242 = 26×22 cells) | centre (67%, 39%) → spans x 55–79%, y 25–53% | green |
| **reviewer ghost** (canvas 154×198 = 22×18 cells) | centre (68%, 72%) → spans x 58–78%, y 60.5–83.5% | mixed, lower density (§6) |
| **brief card** (`figure`, 108×104) | centre (39%, 46%) → spans x 31.9–46.1%, y 40–52% (the reference's 84-wide card cannot hold the six §5 lines at 11px without clipping — measured 2026-09-07, Batch 3.B; the routes are drawn to the card's centre and occluded by it, so the edges they meet are the card's real edges) | `tasks.md` — §5 |
| **route A: planner → card** | horizontal from the planner's right rim (27.8%, 46%) to the card's left edge (31.9%, 46%) | `--ink-3`, `1px dashed` (4px on / 4px off) |
| **route B: card → implementer** | horizontal from the card's right edge (46.1%, 46%) to the implementer's left rim (55%, 46%) — it enters the ghost's lower third | same stroke, straight |
| **route C: card → reviewer** | from the card's bottom centre (39%, 52%) down to (39%, 60%), right to (49%, 60%), down to (49%, 72%), right to the reviewer's left rim (57.9%, 72%) | same stroke; corners are hard 90°; no curves anywhere |
| **tick + label: planner** | tick 1px × 28px `--ink-3`, top-anchored at (14%, 18%) (ends 21.3%, the crown starts at 24%); label right of the tick, `--text-label` `--ink`: `CLAUDE` / `+ FABLE` | |
| **tick + label: implementer** | tick top-anchored at (67%, 18%); label `OPENCODE` / `+ DEEPSEEK` | |
| **tick + label: reviewer** | tick top-anchored at (76%, 55%) (below the implementer's bottom at 53%, above-right of the reviewer's crown); label `CODEX` / `+ GPT-5.6°` | the `°` marks the seat that signs off |
| **seat label: planner** | top-left at (6%, 60%) — below-left of the ghost (bottom 56%) | `PLAN` (`--ink`) then `ANALYZE` / `DECOMPOSE` / `ROUTE` (`--ink-3`), `--text-micro`; a 1px×12px tick above it; closed by `.dash` |
| **seat label: implementer** | top-left at (84%, 36%) — right of the ghost (right rim 79%) | `IMPLEMENT` / `GENERATE` / `ITERATE` / `TEST` |
| **seat label: reviewer** | top-left at (82%, 76%) — right of the ghost (right rim 78%) | `REVIEW` / `READ` / `EVALUATE` / `CONFIRM` |
| **`+` crosshair** | centre (30%, 70%) — moved from (26%, 63%) on 2026-09-07 (fix cycle 1), where it sat on the PLAN label's right edge | `--ink-3`, 14px — drafting mark |
| **rain** | two seeded glyph columns, one per lab seat, centred on the tick's x (planner 14%, implementer 67%), 6 cells (42px) wide, from y 6% down to y 17.5% — 9 rows of 11px; the column ends 0.5% above the tick top, so the tick reads as the funnel that carries the rain into the crown | `.`/`:` glyphs, `--ink-4`, `--text-micro`, placed by `features/diagram/rain.ts` (`rainPoints`, `lib/noise` seeded): a cell lights when its hash falls under a share that tapers from 36% on the top row to 20% on the bottom row, so at most 30% of a column's 54 cells are lit (planner 10, implementer 15; the bottom share was 12% until 2026-09-07, Phase 4 — the Phase 3 critic measured the lowest rows as empty, so the funnel into the tick was not perceptible on a still frame). Replaced the 2px dotted gradient line on 2026-09-07 (fix cycle 1): a single dotted line read as a leader from the claim's dash down to OPENCODE, not as weather. Placed by JS like the scatter, so the no-js page has no rain. → part of the motion concept (§7); the column never touches the tick or its label. The compact stage (§11) has no rain: its ticks sit on the rail beside the ghosts, so there is no funnel for it to fall into |
| **scatter** | ~60 `.`/`:`/`·` glyphs in a loose diagonal band from (0%, 6%) to (24%, 26%), a light trail of ≤ 30 `.`/`:` glyphs across the lower-left quarter (x 0–39%, y 60–100%; more than 4× sparser than the band, clear of the PLAN label, the `+` and every other keep-clear box), a second light trail of ≤ 12 `.`/`:` glyphs under the reviewer (x 55–100%, y 85–100%), plus a sparse halo (≤ 40 glyphs) within 30px of each ghost's rim | `--ink-4`, generated by `features/diagram/scatter.ts` with a fixed seed so renders are deterministic; anything outside the stage is clipped by the box. The lower-left trail was added 2026-09-07 (fix cycle 1): the quarter under the planner was a void that pointed at nothing; the lower-right one on 2026-09-08 (Phase 6, from the Phase 5 critic): the corner under the reviewer was the last void. On the compact stage (§11) the band and both trails give way to one trail of ≤ 12 glyphs beside the card (x 60–100%, y 28–48%); the halos follow the ghosts |

The three routes are drawn once, as one inline `<svg class="route-lines">` per tier (`viewBox` = the stage, `inset: 0`) holding three `<path class="route route--a|b|c">` — `stroke-dasharray: 4 4`, `--ink-3`, `shape-rendering: crispEdges`, hard corners. The path's `d` is the single source for the drawn line **and** for the packets' `offset-path`: `packet.ts` parses it, extends it 8 px into the rims, and derives the cue times from its length (§7.3). The endpoints in each `d` are hand-derived from the ghost centres and sizes in the table above (the compact `d`s from §11's spine): moving a ghost means editing the `d` — nothing recomputes it. Until 2026-09-08 (Phase 6) the routes were CSS gradient boxes and `packet.ts` carried its own copy of route C's corners; the compact tier (§11) needed a second polyline set, so the drawing became the truth and the copy went.

The ghosts are the top-3 elements by rendered size on the page after the headline (nuke-design rule 2); nothing in the diagram may be brighter than a ghost's spark cells except the route packet while it travels.

## 5. The brief card (`figure.brief`)

`max-content` × 104px (108px wide at 11px — the reference's 84 clips `T3 jwt.test.ts`; `min-width: 84px`), 1px `--hair-strong`, inset top highlight, padding `--s-2`, background `--bg` (it must occlude the route line behind it). Content, `--text-micro`, `--font-mono`:

```
tasks.md            ← --ink, weight 500, 12px, as <figcaption>
TASK BRIEF          ← --ink-3, letter-spaced eyebrow
──────              ← 1px --hair, full width, margin-block --s-2
T1 jwt.ts       ✓   ← --ink-2, the ✓ in --green
T2 guard.ts     ▸   ← --ink, the ▸ in --blue (the task in flight)
T3 jwt.test.ts      ← --ink-3
```

The glyphs `✓ ▸` come from JetBrains Mono (it has them); no icon font. Card width stays fixed; overflow hidden; text never wraps.

## 6. The ghosts — `src/features/diagram/{seats,silhouette,density,atlas,ghost}.ts`

**Concept:** each seat is a daemon — a Pac-Man-lineage ghost silhouette rendered as a field of terminal characters whose density breathes. Not a mascot: no mouth, no smile, the eyes are voids.

**Cell grid (locked):** cell `7 × 11` CSS px, glyphs drawn at `11px "JetBrains Mono"`. Grids: planner `30 × 25`, implementer `26 × 22`, reviewer `22 × 18` (aspect ≈ 1 : 1.3 like the reference). The canvas is sized `cols*7 × rows*11` CSS px and backed at `devicePixelRatio` (cap 2). It is never resized by CSS; the diagram box scales it with `transform` (wordmark/ASCII lock rule).

**Silhouette** `inside(u, v)` on normalised coords `u ∈ [0,1]` across, `v ∈ [0,1]` down:
- crown: for `v < 0.42`, inside a semi-ellipse centred `(0.5, 0.42)` with radii `(0.5, 0.42)`
- body: `0.42 ≤ v < 0.86` full width
- skirt: `0.86 ≤ v ≤ 1`: four scallops — inside when `v ≤ 0.86 + 0.14 * |sin(u * 4π)|`
- eyes: two ellipses centred `(0.34, 0.40)` and `(0.66, 0.40)`, radii `(0.11, 0.13)` → **void** (density 0). One pupil cell `@` per eye on the pupil row `⌊0.40 · rows⌋ + gaze.r`: take the void's cell span on that row, `mid = (first + last) / 2`, pupil column `⌊mid + gaze.c / 2⌋` — half a cell **toward the brief card** (planner gaze `+1` → cols 10/20; implementer `−1` → 8/16; reviewer `−1`, and one row up → 6/13). Measured 2026-09-07 (fix cycle 1): the earlier "eye centre + one cell" put the pupils against the socket wall and the two eyes disagreed by a cell; the span midpoint keeps a free cell on both sides of every pupil.

**Density** `d(c, r, t) ∈ [0, 0.875]` for body cells (only the pupils return 1):
- base `d0 = 0.42 + 0.42 * (1 − dist⁴)` with `dist = clamp(hypot((u − 0.5) / 0.5, (v − 0.6) / 0.85), 0, 1)` — a plateau whose peak is the belly (`v = 0.6`), flat across the middle of the body and dropping only at the rim. The vertical radius was 0.7 until 2026-09-07 (Phase 4, Phase 3 critic's craft item): the crown apex sat at `dist ≈ 0.83`, base 0.64, and after the ×0.45 edge falloff the top two crown rows rendered as `.`/`:`; at 0.85 the apex is `dist ≈ 0.68`, base 0.75, and the crown rows render `:`/`-`/`=` like the reference's. Measured 2026-09-07 (fix cycle 1): the dome `0.55 + 0.45 (1 − dist²)` centred at `v = 0.5` put the brightest row two cells under the eyes (a grin), and once the eye ring was gone it made the column between the eyes one and a half glyphs brighter than the cheeks (a nose); the quartic keeps bridge and cheeks within half a glyph and the crown as dense as the reference's
- weave: odd rows `× 0.85`, odd columns `× 0.88` — louvres, not stripes: glyphs alternate within a row (`oOoO` / `:.:.`) as well as between rows; at `t = 0` at least 40% of adjacent body-cell pairs differ in glyph (tested; measured 63–68%). The earlier row-only `× 0.72` read as horizontal banding
- edge falloff: cells whose 8-neighbourhood is not fully inside the **silhouette** `× 0.45`. The eyes do not count as edges — counting them dimmed a ring around each void, which framed a bright patch under the eye gap (the mouth of fix cycle 1) and a bright bridge between the eyes
- breath: `× (0.82 + 0.18 * sin(2π t / P + phase))`, `P` per seat: planner 6.5s, implementer 2.8s, reviewer 9s; `phase`: planner 0, implementer 2.1, reviewer 1.0. Frame 0 is what every screenshot and every reduced-motion visitor sees, so no seat may open at the trough: the reviewer's earlier 4.2 opened at `× 0.66` and read as dirt beside the others (lit-pixel share 0.15 vs 0.22/0.26, measured 2026-09-07); at 1.0 it opens mid-breath (`× 0.97`; share 0.27 vs 0.23/0.28)
- noise: `+ 0.18 * n(c / 4, r / 4, ⌊t*F⌋ / 4)` with `n` a seeded value-noise (deterministic per seat; **no `Math.random` at render time**) and `NOISE_SPAN = 4` — four cells spatially and four ticks temporally, so the grain is coherent blotches that drift rather than per-cell static; `F` = planner 6 Hz, implementer 12 Hz, reviewer 4 Hz
- clamp: body cells are capped at `0.875` = glyph index 7 (`O`); `@` (index 8) is reserved for the pupils, so no body row can ever grin
- halo: cells **outside** the silhouette whose 8-neighbourhood touches it (the one-cell ring) get `d = 0.05 + 0.1 * n` — a `.` only where `n ≥ 0.75`, about a quarter of the ring (the scattered `.` around the reference ghosts). Until 2026-09-07 (Phase 4, Phase 3 critic's craft item) the rule was `0.08 + 0.1 * n` over a two-cell ring, which lit ~55% of both rings and read as fog rather than stray cells
- reviewer: no global gain (it is the quiet seat, and its all-dim palette is what keeps it quiet; rendered on 2026-09-07 during Batch 3.B, `× 0.7` and `× 0.85` both read as dirt — at frame 0 its breath is already at the trough, `× 0.66` — so the multiplier was removed and the palette alone carries the restraint)

**Glyph ramp** (density → char): `' ', '.', ':', '-', '=', 'o', '0', 'O', '@'` — index `⌊d * 8⌋` clamped. **Colour ramp:** alpha belongs to the glyph index and is baked into the atlas once per `(glyph, tint)` tile — `d < .3` → alpha `.55`; `.3–.7` → `.6 + d*.4`; `> .7` → alpha 1. The tint is chosen per cell by `tintFor(seat, d, hash)`: `d < .3` → `*-dim`, otherwise the accent; every cell whose seeded hash `< 0.12` draws in `--white-spark` instead (the sparkle). Reviewer: hash chooses blue-dim / green-dim / spark at 55/35/10.

**Glitch:** every 3–7s (seeded schedule), one random body row shifts by +1 col for 90ms (implementer) or 160ms (planner); the reviewer never glitches.

**Rendering:** one **glyph atlas** per ghost — an offscreen canvas holding each `(glyph, colour)` pair pre-rendered once; the frame loop is `clearRect` + `drawImage` per non-empty cell. Frame loop via `requestAnimationFrame`, but cells update on a fixed tick (planner/implementer 12 fps, reviewer 8 fps); the rAF only redraws when the tick changed. The loop **pauses** when `document.hidden`, when the canvas leaves the viewport (`IntersectionObserver`), and never starts when `matchMedia('(prefers-reduced-motion: reduce)')` matches — then it draws frame `t = 0` once. The loop is `diagram/ticker.ts` (`createTicker(canvas, rate, onTick)`), shared with the rain drift (§7.2). `ghost.ts` exports `createGhost({ canvas, seat, pose? })` → `{ renderFrame(t, pose?), start(), stop() }` (grid, seed, and timing come from the `Seat` record in `seats.ts`; `pose` is read every tick and hands `density()` the §7 reaction — gaze, lift, gain, jolt); `silhouette.ts`, `density.ts`, and `atlas.ts` hold the pure functions and are unit-tested.

**Accessibility:** each canvas carries `role="img"` and `aria-label` — `"Planner daemon: Claude Code with Fable"`, `"Implementer daemon: OpenCode with DeepSeek"`, `"Reviewer daemon: Codex with GPT-5.6"`.

## 7. Motion — one concept: *the system is alive and routing*

Everything that moves belongs to this one idea; nothing else animates. Phase 4 (2026-09-07) added the responses recorded under each item — every one of them is something the packet causes — and the list below is the whole of what the code does; a task-row flip on the card (`T2 ✓`, `T3 ▸`) was built and removed: it marked the task done before the implementer had received it and snapped back at every loop seam.

1. **Breath** — the ghosts' density field (§6). Calm planner, quick implementer, slow reviewer. The loops run on `diagram/ticker.ts` (`createTicker(canvas, rate, onTick)`: planner and implementer 12 fps, reviewer 8 fps; paused while the tab is hidden or the canvas is off-screen). Each ghost also **reacts to the packet** through the `Pose` it hands `density()` every tick (`pose.ts`, pure, from the timeline's clock): *gaze* — the pupils point at the packet: `c` = −1 / 0 / +1 by whether it is left of, within, or right of the middle half of the ghost's box, `r` = −1 / 0 / +1 against a band 40% of the box height either side of the eye row, and the seat's own gaze (§6) returns whenever nothing is in flight — so all three sit level while the brief runs planner → card → implementer, the planner and the implementer drop their gaze one row while it goes down to review (2.7–8.8 s), the reviewer meets it level on the last leg, and everyone looks back toward the card at rest (the ±25% band measured 2026-09-07 kept every ghost looking down for 84% of the loop, because both routes run below the eyes); *lift* — the rim cells (edge falloff ×0.45) rise to ×0.9 over the 0.6 s before the packet touches the seat and settle back over 0.3 s (planner, bracing before it emits at t = 0), 0.5 s (implementer) or 0.6 s (reviewer); *gain* — the reviewer alone multiplies its body ×1.15 for 0.4 s when the packet lands (the confirm); *jolt* — the implementer alone tears when the packet lands: its seeded glitch row shifts one cell for 250 ms (`pose.ts` `JOLT`), three consecutive 12 fps ticks, while the body stays put — a glitch, not a stumble. The seat's own 90 ms glitch length was one 83 ms tick and invisible in every capture (fix cycle 1); measured on real-time frames 2026-09-07 the torn row holds at 2.73, 2.82 and 2.90 s and returns at 2.98 s. The per-seat moments come from `timeline.ts` `schedule()` (planner 0 s, implementer 2.69 s, reviewer 8.71 s at 760×860 — §7.3).
2. **Rain** — the seeded glyph columns above planner and implementer (§4) drift downward at 14 px/s: `rain.ts` `rainPhase(t)` turns the elapsed time into a whole-pixel translate of the column (0–10 px) and a *generation* every 11 px; each generation moves every surviving glyph one row down (its lit test is re-evaluated at the new row's share, so the fall thins toward the tick and the taper survives the motion) and re-seeds the top row. Driven from `diagram/mount.ts` by the same ticker at 14 Hz. The rain is glyphs, not a gradient, so it is no longer a `background-position` shift.
3. **Packet** — two `--white-spark` `■` elements (7×7px), `.packet--impl` and `.packet--rev`, on one shared timeline whose length is derived from the drawn routes (`timeline.ts` `schedule()`: every visible leg at `SPEED` 55 px/s, the card crossing `DWELL` 0.6 s, then `REST` 1.3 s after the reviewer's landing — 10.0 s at 760×860, 5.7 s on the compact stage, where a `HANDOFF` of one `DWELL` sits between the implementer's landing and the reviewer leg; one WAAPI animation per element, infinite, `fill: both`). **One speed, 55 px/s, on every visible leg**: the legs are timed to their measured stage lengths — route A 39 px, route B 76 px, route C 331 px (the fix-cycle-1 critic measured 33 / 47 / 83 px/s, so one object read as two). t 0–0.7 s `.packet--impl` fades in over 120 ms and travels route A from 8 px inside the planner's rim (it emerges between the rim glyphs) to the card's left edge · 0.7–1.3 s it crosses the card **behind** it (`timeline.ts` `DWELL`; the card occludes, §5 — the one leg that is not 55 px/s, and it is never seen) while the card's outline takes the packet's colour — `border-color` `--hair-strong` → `--white-spark` over 100 ms, held to 1.3 s, back by 1.4 s; the `T2 … ▸` row already rests at `--ink` (§5) and does not change · 1.3–2.7 s it travels route B to 8 px inside the implementer's rim, then fades out over 120 ms while the implementer's tick flares `--ink-3` → `--white-spark` (50 ms up, held 0.4 s, back over 100 ms) and its seat list `GENERATE / ITERATE / TEST` lifts `--ink-3` → `--ink-2` on the same envelope · at 2.7 s `.packet--rev` appears 8 px above the card's bottom centre and travels route C (6.0 s, to 8.7 s), then fades out while the reviewer's tick and seat list answer the same way — on the compact stage, where route C leaves the implementer's skirt, `.packet--rev` waits `timeline.ts` `HANDOFF` after the landing (one `DWELL`, 0.6 s; 0 on the wide stage, where the card already separates the two packets): the implementer packet fades at the crown, the tick flares and the jolt runs with nothing lit, then the reviewer packet emerges at the skirt — paused frames 2026-09-08 (fix cycle 1): at the landing only the implementer's is lit, at +0.3 s both are dark while the tick is `--white-spark`, at +0.9 s only the reviewer's is lit, 16 px down route C; until then `rev.from` was the landing itself and the compact stage moved the packet 226 px from crown to skirt in one frame · 8.7–10.0 s rest (both hidden): the reviewer's flash ends at 9.25 s, the planner braces from 9.4 s and the next brief leaves at 10.0 s — one beat of stillness, measured on paused real-time frames 2026-09-08 (Phase 6, the Phase 4 critic's item; until then the loop was 9 s and re-emitted 0.3 s after the landing) — every reaction is a cue-relative loop started with a WAAPI `delay` of its cue, so nothing is folded at the seam. Measured 2026-09-07 (fix cycle 1) from `offsetDistance` at paused times: A 55.8 px/s (8.4 → 36.3 px over 0.15–0.65 s), B 54.2 px/s (149.6 → 220.1 px over 1.35–2.65 s), C 55.2 px/s (2.8 → 328.3 px over 2.75–8.65 s). The tick labels themselves stay `--ink`: a flash to `--white-spark` measured invisible on 2026-09-07 (a 3% step), so the tick carries it. Each packet tows a **wake**: three `--white-spark` squares of 5, 4 and 3 px at opacity .45, .30 and .15 riding the same path and keyframes 0.12, 0.24 and 0.36 s behind it (a WAAPI `delay`), so the tail is the same 20 px on every leg (measured 20.1 / 19.6 / 19.9 px on A / B / C) and closes up where the packet stops. Implemented in `features/diagram/packet.ts` as `offset-path: path(...)` with `offset-distance` keyframes — `route-geometry.ts` parses each route's SVG `d` (§4) into its polyline in stage px and extends it 8 px past both ends — so packets and wakes stay glued to the lines under `transform: scale()` and on either stage. The timeline starts at boot, so on first load the planner's leg overlaps the diagram's entrance: the system is already running when it appears.
4. **Entrance** — on load only: `nav` (0) · steps, the `/` mark and the claim (1) · `TWO MODELS` (2) · `ARE GOOD.` (3) · `A SYSTEM` and the diagram (4) · `IS BETTER.` (5) · lede (6) · CTA (7) · works-with (8) fade from `opacity 0; translate 0 8px` to rest, each starting at its index × 60 ms, 480 ms, `ease-out`, `both` — so the diagram fades in as one unit after 240 ms. The fragments layer fades in over 480 ms once placed. No scroll-triggered animation anywhere; the routes/manifesto sections are static.
5. **Background fragments** — `features/fragments/mount.ts` places the 20 mono strings of the pool below, each once, across the viewport (`position: absolute; inset: 0` layer behind content — sized by the initial containing block, so it is the first viewport and scrolls away with the hero — `z-index: -1`, `--ink-4`, 11px, opacity `.18–.35`), each hovering: it drifts upward 64px over 14–28s (120 px, then 96 px until 2026-09-08, see the seed note), fading in over the first second and out over the last 2s, and restarts at its origin (no wrapping, no infinite scroll); each starts mid-cycle at its own seeded phase (a negative `delay`), so nothing moves in unison. Pool: `brief -> implementer`, `typecheck · lint · test`, `retry(3) -> escalate`, `const brief = compile(spec)`, `while (red) retry()`, `promote(diff)`, `evidence.jsonl`, `real software`, `lower spend`, `fewer blind spots`, `one file per brief`, `0x2f 0x62 0x72`, `[ 3 / 7 ]`, `∴`, `//`, `→`, `T1 ✓`, `T2 ▸`, `hash ok`, `worktree` (20 strings). Origins, drift durations, opacities and phases are drawn from `lib/noise` `hash` with seed 8088 (no `Math.random` anywhere in `src/`; seed 74 carried Phases 4–5, seed 912 Phase 6 to T-014 and seed 7958 T-015 to the final fix — on 2026-09-08, Phase 6, the diagram's scatter and rain glyphs joined the keep-clear list and type earned a 24 px horizontal clearance, after which no seed of 1000 placed all 20 with a 120 px rise; at 96 px, one `--s-24`, seed 181 placed 20 with none on a text line. Fix cycle 1 the same day added the two gutter strips and the label blocks below, after which no seed of 2000 placed more than 17 at 96 px; at 64 px, one `--s-16`, 209 of 1500 seeds place 20, and seed 912 was the one with no fragment on a label's lines within 100 px and the widest spread. T-015 (2026-09-08) added the quiet strip under the nav and the two rain column boxes below, after which seed 912 placed 18; 20 of 5 000 seeds place 20, six of them keep every label's lines clear within 100 px at the origin, and seed 7958 is the one of those with the widest spread (82 px between the nearest two origins) — its one travel-band crossing is `typecheck · lint · test` reaching the `+ FABLE` line 64 px to its right in the fading last second of its rise; no seed of 20 000 has none. The final fix (2026-09-09) set the lede four lines deep, and that one line of free height was the margin: no seed of 30 000 places all 20 at 1440×900 any more — 23 place 19 — so seed 8088 is the 19-seed with no origin within 100 px of a label's lines and the widest spread (70 px); `worktree` is the string it leaves out. The seed search measures the page at `fonts.ready`, as `main.ts` does — the rain has drifted a few px by any later moment and the placement differs), so the layout is identical on every render and the screenshots are reproducible. Each string's first 1000 candidates are drawn from its own quarter of the free height (string *i* → stripe *i* mod 4) and no origin lands within 60 px of another, so the strip under the nav no longer collects half the pool. Fragments never overlap the type or the diagram's marks: the placer rejects any origin whose box **plus its full 64px travel band** (6 px margin; type boxes are also grown 18 px each side, so a fragment's ink stays `--s-6` from any text line — the Phase 6 fold had `typecheck · lint · test` reading as a fourth word of `+ DEEPSEEK`) intersects a keep-clear box — the headline, lede and CTA the concept demands, **the whole header band and a `--s-6` quiet strip under it** (`header.nav`'s box stretched to the full viewport width and grown 24 px down, so the gutters beside the wordmark and the links are silent too and no fragment's ink rises within one line of the tagline — the Phase 6 critic's carry, applied in T-015), the steps' cells, the `/` mark, the claims, works-with, the three canvases, the tick labels, the seat labels, the card, the three routes, the `+`, every scatter glyph (each `span` is a mark, since Phase 6) and **the two rain columns as boxes** — 42 px wide on each lab tick's x, from y 6 % of the stage to the tick's top (§4); the rain drifts, so the glyphs lit at boot were the wrong shape to keep clear (T-015), **the two gutter strips** (`.hero`'s left offset wide, full height — until fix cycle 1 nine of the 20 sat outside the 64 px gutters and single glyphs at x = 7 and x = 1390 read as clipped marks on the screen edge) and **each tool label and seat list grown by its own width to either side and one line height above and below** (a gap narrower than the block reads as a third column of it — the fold had `typecheck · lint · test` 42 px right of `+ DEEPSEEK` reading as its tail, and after the first fix `while (red) retry()` 24 px beside it on its own line; the 24 px text clearance alone never blocks a same-line neighbour), and, since Phase 5, the routes eyebrow and rows, the manifesto heading, paragraph and list, and the three footer columns (the layer is the first viewport and the boxes are measured at scroll 0, so the lower sections take part only on a viewport tall enough to show them at load; the atmosphere lives in the hero — below the fold the page is silent. Until 2026-09-08 the layer was `position: fixed` and at max scroll 11 of the 20 rode across the routes rows, the routes claim and the footer tick; `absolute` keeps them with the hero without a scroll-linked animation, which this section rules out) — or a band already taken by another fragment, so no two fragments ever cross. `main.ts` measures the boxes once after fonts load and again on `resize` (one queued `requestAnimationFrame`, so a drag re-places once per frame), **at rest**: every finite animation (the entrance) is sampled at its end and restored inside the same task, so the 8 px entrance offset never shifts a placement (it moved the count between 27 and 28 until 2026-09-07). Origins sit at least one travel (64 px) below the top edge and above the fold, so every band — origin to the end of its rise — stays on screen for the whole cycle (fix cycle 1: 8 of 28 were parked at y ≈ 1–13 and rose off-screen before their fade-in completed, and 14 bands crossed the nav); the search draws up to 2000 seeded candidates per string — at 1440×900 19 of the 20 place, and **the header band is silent**. The narrower tiers keep whatever fits between the type and the marks: 20 at 1024×900 and 12 at 768×900 (measured 2026-09-09, seed 8088 — 15 / 8 under seed 7958; none outside the gutters at any width). Below 768 `mount.ts` places nothing (`PHONE`): the phone hero is all type and diagram, and the two or three strings that fitted there sat in the claim → headline gap and read as a fourth claim line — `brief → implementer`, `typecheck · lint · test` (the final critic, 2026-09-09) — so the atmosphere is a desktop thing. Opacity never exceeds `.35`.

`prefers-reduced-motion: reduce` → 1 renders frame 0 only (the seat's own gaze, no lift), 2/3/5 are off (`animation: none`; both packets and their wakes `display: none`; `main.ts` calls `stop()` on the diagram and the fragments, which cancels every WAAPI animation — the card outline, ticks and seat lists sit at rest — and leaves the fragments static at their origins), 4 is replaced by instant visibility. `@media (prefers-reduced-motion)` lives in `src/styles/motion.css` alongside the keyframes; `lib/reduced-motion.ts` owns the single `matchMedia` and its `change` subscription, and `main.ts` starts or stops both features live when it fires.

## 8. Routes section (`section.routes`)

Eyebrow `EXAMPLE ROUTES` (`h2`, `--text-label`, `--ink-3`). Table `--text-label` (12px, no uppercase transform — model names are lowercase here, as in the reference), row pitch 26px, `--ink-2` cells, arrows `→` in `--ink-3`, comment column `// feature` in `--ink-3`. Five columns: `#` (32px) · plan · implement · review · goal. The `→` arrows are CSS `::after` content on the plan and implement cells (`--ink-3`, `padding-inline`), so the DOM has exactly five columns and five visually hidden `scope="col"` headers (`#`, `PLAN`, `IMPLEMENT`, `REVIEW`, `GOAL`). The review cell's model carries the `°` sign-off mark. The table is content-sized inside cols 1–9 (`justify-self: start`; 769 px at 1440): each arrow floats to the right edge of its cell with `--s-12` on both sides, so the arrows form a column 48 px before the next model and ≥ 48 px after the longest one in their column, and the review cell keeps `--s-12` before the comment — stretched to the nine columns, the arrows sat 100 px from their own row's text and read as bullets (measured 2026-09-07, Phase 5). The index column is `--ink-3` and letter-spaced `.08em`, like the steps' and the manifesto list's numbers; the review column is `--ink` — the seat that signs off reads a step brighter than the two it checks (Phase 5 critic, applied 2026-09-08). The arrows stay at `--s-12`: at 1440 they form a column 48 px clear of both neighbours and never read as tight to their rows, so the optional `--s-16` gutter was not taken. Below 768 the arrows become `↓` on their own line (§11).

| # | plan | implement | review | goal |
|---|---|---|---|---|
| 01 | claude + fable | opencode + deepseek | codex + gpt-5.6° | // feature |
| 02 | codex + gpt-5.6 | ollama + qwen3-coder | claude + sonnet° | // refactor |
| 03 | claude + sonnet | opencode + qwen3 | codex + gpt-5-codex° | // bugfix |
| 04 | cursor + gpt-5.6 | lm studio + devstral | claude + opus° | // docs |
| 05 | claude + opus | copilot + gpt-5-mini | codex + gpt-5.6° | // tests |

Right claim (cols 11–12, the hero claim's rail, aligned with the eyebrow): `MIX THE LABS.` / `ONE SHARED BRIEF.` — `--text-label`, `--ink`; closed by `.dash` (owner's copy, 2026-09-09; `DIFFERENT LABS.` until then).

## 9. Manifesto (`section.manifesto`) — the breath

Three columns, `padding-block: var(--s-32)`:

- **Heading** (cols 1–4, `h2`): `// YOU DESCRIBE` / `THE GOAL.` / `SPLITBRIEF HOLDS` / `THE REST.` — `--font-wide`, `--text-wide`, `--ink-3`; `//` in `--ink-4`; `SPLITBRIEF` in `--ink-2`. Four lines, `text-wrap: balance` off (lines are explicit).
- **Paragraph** (cols 5–9): `From research to Task Briefs to review, the stronger tool thinks and the cheaper one types. splitbrief validates every task — typecheck, lint, test — retries, escalates, and keeps the evidence.` `--text-body`, `--ink-2`, `max-width: 36rem` (64 ch; 38rem ran to 68 ch on the 1024 tier — Phase 5 critic, applied 2026-09-08). Closed by `.dash`.
- **List** (cols 11–12, `ol`, on the hero claim's rail — col 10 stays empty, so the paragraph→list gap is one column wider than the heading→paragraph gap): `01 HIGHER QUALITY` / `02 LOWER SPEND` / `03 EVIDENCE ON DISK` / `04 YOUR TOOLS` / `05 YOUR RULES` — `--text-label`; numbers `--ink-3`, labels `--ink-2`; pitch 18px; `white-space: nowrap` on the items and `flex: none` on the number cell — a list label never wraps and the number cell never shrinks. `03 EVIDENCE ON DISK` (owner's copy, 2026-09-09; `REAL EVIDENCE` until then) is 162.6 px with its number, so from 1100 to 1200 it overruns the two-column rail into the right gutter — 15.4 px at 1100, 0 at 1201 — the way the rungs overrun cols 1–4 near 768 (§15.2); without `flex: none` the flex row shrank the `03` cell to 16.6 px and set `03EVIDENCE ON DISK`. Closed by `.dash`.

## 10. Footer (`footer.foot`)

Preceded by a short rule (cols 3–10). Three columns, `--text-label`:

- left (cols 1–3): `BUILT FOR` / `PEOPLE WHO` / `ACTUALLY BUILD` — `--ink-2`; `.dash`.
- centre (cols 5–8): a 1px × 48px vertical tick centred, then `[ github.com/b4r7x/splitbrief ]` as a link (same hover/focus rules as nav links), `--ink-3`.
- right (cols 11–12, the hero claim's rail): `SAME TOOLS.` / `BETTER OUTPUT.` — `--ink`; `.dash`.

`padding-block: var(--s-16) var(--s-12)`. Below 768 the columns stack in source order except the link, which takes `order: 1` so the page ends on the centred tick and link (§11). The nav and footer links are 44 px tall targets: `padding-block: calc((44px - 1lh) / 2)` with the same negative `margin-block` and `min-height: 44px`, so the hit box grows without moving the text (§12).

## 11. Responsive tiers

| width | layout |
|---|---|
| ≥ 1100 | as above; the diagram box scales fluidly between 584px and 760px wide via `width: 100%` on the 7-column span; ghosts keep their pixel size (they are placed by %) — at 584px the scale factor is ~0.77, applied with `transform: scale()` on an inner 760×860 stage |
| 768–1099 | hero stacks: left column full width (headline 55.3 px at 1024), the diagram after the CTA at `max-width: 760px` with `margin-top --s-6`, and works-with last (`order: 1`; until 2026-09-09 the diagram followed works-with with `--s-12` above it, so the first 900 px held no part of the object — the final critic's item): the diagram's top edge sits at y 823 at 1024 and 810 at 768, so the fold cuts the object's scatter and rain, but the planner's crown stays under it — canvas top 1 030 at 1024 and 1 000 at 768; the ≈ 130 px that would bring it inside 900 can only come from the headline block (the `--s-24` above the h1 and the `--s-24` stanza gap), the owner's call — `--fit` is `min(1, box / stage)`, so the cell grid is never upsampled (until 2026-09-08 the box was the full content width and the stage scaled ×1.23 at 1024); nav: the tagline moves to cols 4–6 with `white-space: nowrap` (at cols 3–4 it wrapped into the wordmark from 1000 down) and the links to cols 7–11; routes table keeps all columns (arrow gutters `--s-8`, 689 px at 768) with the claim **under the table** at cols 10–12, `margin-top --s-8` (on the eyebrow row it pushed the table 73 px down — Phase 5 critic); the hero claim sits at cols 10–12 on the steps row, so the hero claim, the routes claim, the manifesto list and the footer's right column share one rail — x = 763.5 at 1024 and 577.1 at 768, measured 2026-09-08 (fix cycle 1; at cols 7–12 the two claims floated at x 524, aligned to nothing); manifesto becomes 2 rows (heading full width, then paragraph + list side by side, `row-gap: var(--s-12)`); the manifesto list and the footer's right column keep cols 10–12 at this tier (on the 1440 rail, 11–12, `HIGHER QUALITY` and `BETTER OUTPUT.` wrap from 1000 down — measured 2026-09-08); footer 3 columns, the centre one cols 4–9 so the repo link never breaks |
| < 768 (390 target) | nav: a flex row of wordmark + links only (`justify-content: space-between`, `column-gap --s-4`, links `gap --s-3`, `white-space: nowrap`); the tagline and the 9-dot mark are `display: none` (both decorative; at 360 the wordmark's 140 px and the links' 159 px fill the 320 px row to the pixel). Headline `--text-display` becomes `clamp(2.75rem, 13vw, 3.25rem)` (§1), so `TWO MODELS` never wraps: 339 px at 390, 313 px at 360. **Diagram compact tier** (`@container hero (max-width: 700px)` — `.hero` is the `hero` inline-size container and 700 px is its width at a 768 viewport): the 760×860 stage is replaced by a vertical **350×980** stage (the box `max-width: 350px; aspect-ratio: 350 / 980`), scaled by `min(1, box / 350)` — 1.0 at 390, 0.914 at 360. One spine at x = 38% (133 px) carries, top to bottom, the planner (centre 15% → y 9.5–284.5), the card (39% → 330.2–434.2), the implementer (61.5% → 481.7–723.7) and the reviewer (89% → 773.2–971.2), 46–49 px apart; the routes are the straight vertical dashed segments between them — A planner rim → card top, B card bottom → implementer crown, **C implementer skirt → reviewer crown** (the stack reads plan → brief → execute → review; a card → reviewer bypass around the implementer would have needed a 585 px detour). A rail at x = 71.4% (250 px) holds every annotation: each seat's tick (1×28) and tool label 30 px under the ghost's top (planner 4%, implementer 52.2%, reviewer 82%) and its seat list bottom-aligned 10 px above the ghost's bottom (17.7% / 62.5% / 87.8%); the `+` sits beside the card at (80%, 40%). The first draft of this row put tool labels right and seat labels left of centred ghosts: at 350 px a 210 px planner leaves 70 px a side, and `+ DEEPSEEK` (82 px) and `DECOMPOSE` (67 px) do not fit — hence the spine and rail (2026-09-08, Phase 6). Same canvases, same 7×11 cell grid before the stage's uniform fit-scale; no rain and one trail beside the card (§4); the packets ride the same drawn routes at 55 px/s, so the loop is 5.7 s here — the reviewer leg waits one `DWELL` at the implementer (§7.3); the no-JS `<pre>` art sits on the same spine. The claim keeps cols 7–12 (163 px at 390, 148 px at 360 — `FEWER BLIND SPOTS.` is 147 px), three lines. The lede's `<br>` is hidden (below 1250, §4) so `text-wrap: pretty` sets the paragraph (the forced break left a 16-character line, `against one job.`, in an eight-line block). Works-with becomes a 2×3 grid (`grid-auto-flow: column`, gap `--s-8`) with the dash on the block. Routes table: index + plan / implement / review stacked as three lines per row with the goal comment as the first line (`// feature`), arrows become `↓` on their own line — each `tr` is a two-column grid (index · text, rows `--s-6` apart, 18 px lines) with the comment spanning the first line; Chrome keeps the table / row / cell / columnheader roles under the display change (verified through the CDP accessibility tree, 2026-09-07). Manifesto single column. Footer single column, centred tick, the link last (`order: 1`). No horizontal scroll at 390px or 360px. |

Container queries (`@container hero (max-width: …)`) drive the diagram tier; media queries drive the page grid. The diagram's JS reads the tier from the visible `.route-lines` SVG (`checkVisibility()`) and rebuilds its scene — boxes, packets, scatter, rain — when the stage's layout width changes (a rotation across 768); the ghosts' canvases stay. Touch targets ≥ 44px for the CTA and links (padding, not font size).

## 12. Craft floor (checked on screenshots, every phase)

- headline-to-body ≥ 4:1 (124/15 ✓); nav ink ≈ 55% (`--ink-3`) so it recedes
- exactly two accents, each ≤ 3 element types (blue: planner ghost, planner labels/ticks, focus/copy flash · green: implementer ghost, implementer labels, the `✓`)
- one atmosphere (vignette + grain), nowhere else
- no orphans under any headline line; no mid-URL breaks in the footer link (`overflow-wrap: anywhere` only there)
- every interactive element: visible 2px focus ring, hover state, `cursor: pointer`; the nav links, CTA and footer link measure 44 px tall at every width (2026-09-08)
- `::selection` styled; `<html lang="en">`; `<meta name="theme-color" content="#0b0c0e">`; `<title>splitbrief — one plans, one executes, one contract</title>`; `<meta name="description">` = the lede
- Lighthouse a11y ≥ 95, performance ≥ 95 (no assets besides fonts; built JS ≤ 90 KB gzipped including any motion library, ≤ 12 KB gzipped of our own code) — 2026-09-08, desktop, against `vite preview`: performance 99, accessibility 100, best practices 100, SEO 91 (the one SEO miss is the preview server's missing robots.txt)

## 13. Stack and file map (sota-structure)

**Stack:** Vite (vanilla TypeScript template, `base: './'` so `dist/` deploys under any path — it is served over HTTP, never opened from `file://`, which Vite's module scripts do not support; build → `dist/`) · optional `gsap` as the only runtime dependency, imported per module (`import { gsap } from 'gsap'`), tree-shaken, used only inside `src/features/**` · TypeScript strict (`moduleResolution: "bundler"`, extensionless imports — the Vite convention; this package is independent of the CLI's NodeNext config) · Vitest for unit tests, colocated · `@playwright/test` with `channel: 'chrome'` (the installed Google Chrome, no browser download) for e2e, screenshots, and motion assertions, running against `vite preview` · Biome for lint + format. No UI framework; `dependencies` holds at most `gsap`.

```
website/
  package.json               private; scripts: dev · build · preview · typecheck · lint · format · test · e2e · shots · render-static
  package-lock.json          the lockfile `npm ci` installs from
  tsconfig.json              strict, bundler resolution, noUncheckedIndexedAccess, exactOptionalPropertyTypes, types: ["vite/client", "node"] (the e2e files read process.env and vite references the node types)
  vite.config.ts             base './' (host-agnostic asset paths), build.target 'es2022', preview port 4173
  vitest.config.ts           include src/**/*.test.ts, environment 'node' (pure functions only — DOM code is e2e-tested)
  playwright.config.ts       channel 'chrome', webServer 'npm run build && npm run preview', baseURL http://localhost:4173, testDir tests/e2e, testMatch **/*.e2e.ts
  biome.json                 same style as the repo root (2 spaces, 100 cols, single quotes, kebab-case filenames), includes src/ tests/ tools/ and the config files
  index.html                 the page — Vite entry; semantic skeleton, all copy, canvases, <pre class="ghost-fallback"> siblings shown only under html.no-js, the two route-lines SVGs (one per stage) whose path d is the routes' single source
  DESIGN.md                  this sheet
  README.md                  ≤ 10 lines: install, dev, build, preview, typecheck, lint, format, test, e2e, shots, render-static, design-sheet and handoff pointers
  HANDOFF.md                 the maintainer handoff: read order, decisions, process rules, state at finish, how to run, where things are
  handoff/                   the build's evidence — spec.md, requirements.md, plan.md, prompt.md, exec-plan.md, exec-progress.md (the phase ledger), exec.md (per-phase evidence), extension-research.md, reference.png (the visual target) and six milestone captures (p2fix-fold, p6-390, p8e-1440, p8e-fold, p8e-390); every other capture lives in the gitignored run dir `.nuke/2026-09-06-225118-spec-website/shots/`
  .gitignore                 test-results/ (Playwright's outputDir); dist/ and node_modules/ are already covered by the root ignore
  src/
    main.ts                  boot: mountCopyButton · mountDiagram · mountFragments (the no-js → js swap is the inline head script, §2); measures the fragments' keep-clear boxes at rest (§7.5) — text, marks, the header band and its quiet strip, the two gutter strips, the label/seat blocks and the two rain column boxes — and starts/stops both motion features from lib/reduced-motion
    styles/                  the shared stylesheet tier (a technical-type dir is sanctioned in the shared tier of a tiny app)
      main.css               @layer tokens, base, layout, sections, motion; then @import url(...) layer(...) for every stylesheet below, in order
      tokens.css             §1 custom properties only
      base.css               @font-face size-adjusted fallbacks, reset, body (background-color + background-image), grain, ::selection, :focus-visible, .dash, .rule, .visually-hidden, .no-js/.js switches
      nav.css                §3
      hero.css               §4 left column, claim, works-with; the hero grid (the CTA box lives in cta.css)
      cta.css                  §4 CTA: the box, the two-state label grid (idle + notice stacked in one cell), the copy glyph, the copied flash
      diagram.css            §4 right column, stage + fit-scale, routes, ticks, labels, rain, scatter
      brief.css              §5 card (split out of diagram.css on 2026-09-07 — the stage sheet alone sits near the 200-line cap)
      diagram-compact.css    §11 compact tier — stage, spine, rail (the container query); the card's compact position lives in brief.css
      routes.css             §8
      manifesto.css          §9
      footer.css             §10
      brief-sheet.css        §15.1 — the sheet box and its 707 / 689 px crops, the two marginalia statements, the tiers
      ladder.css             §15.2 — the run block, its bar and rows (the callout rail, the phone tails), the rungs (steps grammar), the tiers
      record.css             §15.3 — the tree and its notes (stacked below 768), the two $ lines on the rail, the tiers
      motion.css             §7 keyframes + the prefers-reduced-motion block
    lib/
      noise.ts               hash(seed, x, y, z) and valueNoise(seed, x, y, z) — pure; consumers: diagram/density.ts, diagram/scatter.ts, diagram/rain.ts, fragments/mount.ts (placement seed)
      noise.test.ts
      reduced-motion.ts      prefersReducedMotion(): boolean + onReducedMotionChange(cb) over one matchMedia; consumers: diagram/ghost.ts, main.ts (which starts/stops the diagram and the fragments)
    features/
      copy-button.ts         mountCopyButton(button, clipboard): clipboard write, 1.6 s "copied to clipboard" swap, border flash (the hero CTA; two files, so flat)
      copy-button.test.ts    the label/timer logic with vi.useFakeTimers() and a fake clipboard
      diagram/
        seats.ts             the per-seat config table (grid, period, frequency, phase, glitch, palette) — data only
        silhouette.ts        inside(u, v), eye(u, v), pupilCell(seat, side, gaze?) — pure
        silhouette.test.ts
        density.ts           Pose type; density(seat, c, r, t, pose?) with breath, weave, edge falloff (lifted by pose), noise, clamp, halo; glitchRow(seat, t, jolt?) — pure
        density.test.ts
        atlas.ts             GLYPHS ramp, glyphFor(d), tintFor(seat, d, hash), buildAtlas(seat, dpr) → offscreen canvas it creates itself (alpha per glyph index baked into the tiles)
        atlas.test.ts        ramp bounds + tint bands (pure parts)
        ghost.ts             createGhost({ canvas, seat, pose? }) → { renderFrame(t, pose?), start(), stop() }: fixed-tick loop on ticker.ts, reduced-motion frame 0, the pose read every tick
        scatter.ts           seeded band + trails + halo glyph placement per tier (Field.tier: wide · compact) → DocumentFragment
        scatter.test.ts      determinism + exclusion of ghost interiors and keep-clear boxes + region membership on both stages
        rain.ts              rainPoints(tickXs): the two seeded rain columns (§4) — reuses scatter's point type and fragment
        rain.test.ts         per-column lit cap, taper, glyph set, determinism
        route-geometry.ts    Point, Polyline, length(points), pointAt(points, distance), parsePath(d) ← the SVG route's d, extend(points, by), offsetPath(points) → the CSS path() string — pure
        route-geometry.test.ts
        timeline.ts          SPEED 55 px/s · DWELL 0.6 s · REST 1.3 s · HANDOFF per tier (wide 0, compact one DWELL), and schedule(distances, tier) → Timeline { period, handoff, card, cues (per seat: at · settle · jolt · gain), loop (the infinite WAAPI options), frame(t, style) } — the loop's length derived from the drawn routes, pure
        timeline.test.ts     the 760×860 distances give 0.71 / 1.31 / 2.69 / 8.71 / 10.0 s; the compact stage holds the brief in the implementer for a dwell before the reviewer leg (2.59 / 4.38 / 5.68 s)
        pose.ts              poseAt({ cue, t, period, box, seen }) → Pose (gaze · lift · gain · jolt): a seat's reaction to the packet at time t — pure
        pose.test.ts
        response.ts          reactions(stage, timeline): the keyframes the diagram answers the packet with — the card's outline and the implementer/reviewer tick and seat flashes — each cue-relative and started with a `delay` of its cue, so the reviewer's flash crosses the loop seam
        packet.ts            mountPackets(stage, routes, ghosts): parses the visible route-lines SVG, schedules the timeline from its lengths, rides the two packets and their wakes on offset-path over those polylines, the clock, pose(name) for the ghosts, start/stop
        ticker.ts            createTicker(target, rate, onTick): fixed-tick rAF loop with IntersectionObserver + visibilitychange pause — shared by ghost.ts (cells) and mount.ts (rain); both consumers are this feature, so it stays here rather than in lib/
        find.ts              find(root, selector): querySelector-or-throw, shared by mount, packet and response
        mount.ts             mountDiagram(root): wires seats → canvases and builds the scene — the visible route-lines tier, packets, scatter, rain drift — rebuilding it when the stage's layout width changes; --fit = min(1, box / stage); the only DOM entry for the feature
      fragments/
        pool.ts              the §7.5 string pool — data only
        mount.ts             mountFragments(layer, keepClear): placeFragments(viewport, { text, marks }) with the travel-band test (seeded via lib/noise, 2000 candidates per string in 4 height stripes, 60 px between origins, text boxes grown to a 24 px clearance, every travel band on screen), the hover animation, re-placement on resize (one queued rAF)
        mount.test.ts        all 20 placed on screen, clear of the header band, every exclusion, every text line and each other (the headline is a DOMRect-like object whose sides are prototype getters, so a `{ ...rect }` spread in the placer fails it); same seed + same viewport → identical placements
  tests/
    e2e/
      page.e2e.ts            one h1 · lang · title/description · every canvas labelled · every a[href] · five tbody rows · document.fonts.check for the three families · zero console errors · scrollWidth === clientWidth at 390 and 360 · at 390: the stage is 350×980 with the compact route-lines shown and the three canvases on one x, and the nav links, CTA and footer link are ≥ 44 px tall with a 2px solid :focus-visible ring after Tab · --ink-3 vs #101216 ≥ 4.5 (computed from the live tokens) · gzipped JS: own ≤ 12 KB, own + vendor ≤ 90 KB
      motion.e2e.ts          `test.describe` with `test.use({ reducedMotion: 'reduce' })`: two diagram captures 4 s apart are pixel-identical; default: they differ; CSS layer seeked via the Web Animations API — `page.evaluate(t => document.getAnimations().forEach(a => { a.pause(); a.currentTime = t; }), 2000)` — then the .packet--impl box intersects route B's path box, at 1440 and, on the vertical route, at 390; ghost loops advanced with page.clock (installed and paused one step ahead before goto, so every tick happens inside runFor); 19 fragments at 1440×900 (seed 8088, §7.5), and none intersects the header band or the h1/lede/CTA boxes when sampled at 0, 10, 20, 30 s of animation time; at 390 the hero carries no fragments
      extension.e2e.ts       §15: the sheet (the card's header, cropped at 707 / 689 on a heading, two statements), the transcript (13 rows, ✗ → retry → ✓ in DOM order, the phone tails), the record (tree with six notes, two $ lines, the measurement line), zero animations in all three, the three claims on the routes claim's x
      shots.e2e.ts           writes SHOT_DIR/<SHOT_TAG>-1440.png (full page), -fold.png (1440×900), -390.png (full page, 390×844); SHOT_TIME_MS seeks every CSS animation via getAnimations() and advances page.clock for the ghosts before capture (default 4000); the clock is installed and paused before goto and finished entrances drop to `animation: none`, so two captures of one build are byte-identical
  tools/
    render-static.ts         prints frame-0 character art per seat (imports the pure diagram modules); run once via `npm run render-static`, output pasted into the three <pre class="ghost-fallback">
```

Rules: kebab-case; basename = primary export and never repeats a path segment (the folder carries the feature name — `diagram/mount.ts`, never `diagram/diagram.ts`); a unit earns a folder at 3+ files, otherwise flat siblings; no `utils`/`helpers`/`common`; no `index.ts` barrels; tests colocated; ≤ 200 lines per file (split per responsibility as above, never by line count alone; `index.html` is exempt for the 65 generated lines of `<pre class="ghost-fallback">` art and for the §15 artefacts' bodies — the sheet `<pre>`, the transcript `<ol>`, the tree `<pre>`: data typed into the page, ≈ 70 lines — and its remaining markup, the awk count in T-011, stays under **220**: the three §15 skeletons add ≈ 54 lines of real markup to today's 143, so 200 would leave no room for the seat spans and the marginalia); features never import each other (`copy-button`, `diagram`, `fragments` import only from `lib/` and their own folder; `main.ts` composes); stylesheets live in the shared `src/styles/` tier, one per section. `dist/` and `node_modules/` are gitignored by the repo root already (`dist/`, `node_modules/` patterns are unanchored).

## 14. Verification protocol (every phase)

1. `cd website && SHOT_DIR=<run_dir>/shots SHOT_TAG=p<N> npm run shots` → three PNGs (Playwright builds + previews first; `SHOT_TIME_MS` seeks CSS animations through `getAnimations()` and the ghost loops through `page.clock`).
2. Open each PNG and `reference.png` side by side. Write the defect list **before** touching code: geometry drift (positions vs §4 table), type scale, ink levels, alignment, anything accidental. Name the three worst things first.
3. Fix, re-shoot, re-critique. A phase is done at zero open items on its own surface — not "renders".
4. Gates: `npm run typecheck && npm run lint && npm test && npm run e2e` in `website/` — all green, outputs pasted verbatim.
5. Hand back with: the screenshot paths, the final critique, `craft pass: …` line, and the tell-walk (nuke-design §Verification) result with a 1–10 score anchored to the nuke-design sentences.

## 15. Extension — the brief, the ladder, the record (T-010, 2026-09-08; revised after the Phase 7 reviews)

Three sections after the routes, designed from `.nuke/2026-09-06-225118-spec-website/extension-research.md`. Every string below is quoted from its copy bank (§A–C there) or marked *derived* with its source; every column is on the §1 grid; every token is §1's — no token was added. Each section is static: §7 stays at five items (the reveal decision is recorded under §15.2). Order and arc: **routes → brief → manifesto → ladder → record → footer** — the brief sits *before* the breath, so `SPLITBRIEF HOLDS THE REST.` summarises the sheet the reader has just seen, and because the alternative (brief after the manifesto) stacks ≈ 2 200 px of small print — sheet, transcript, tree — after the breath with no relief, which reads as an appendix. Three dense blocks precede the breath, but they are three different objects at three heights: a 130 px table, a 707 px cropped sheet, and the hero's glyph field above them; the thumbnail reads as rhythm, not stripes (falsifier: if T-015's 10 % thumbnail shows the routes and the sheet fused into one slab, the brief's top gap grows to `--s-32` — the order does not change).

Shared grammar (all three): section grid = the 12 columns of §1, `width: min(var(--content-max), 100% - 2 * var(--gutter))`; eyebrow = `h2` in the routes' eyebrow style (`--text-label`, `--ink-3`), and the three eyebrows are one timeline — `BEFORE ANY CODE` → `AFTER EVERY TASK` → `AFTER THE RUN` (§15.4); the claim sits on the col-11 rail (`grid-area: 1 / 11 / 3 / 13`, `--text-label`, `--ink`, closed by `.dash`). **Source order in every section: eyebrow, claim, object, statements, small print.** Below 768 every item is `grid-area: auto / 1 / auto / -1`, so source order rules and the claim is the second thing read — the section's subhead; at ≥ 768 every item carries an explicit `grid-area`, so the claim renders on the rail whatever its source position. At 768–1099 the claim takes the tier's rail on the eyebrow row (`grid-area: 1 / 10 / 2 / 13`, `align-self: start`; the eyebrow spans 1–9) — not under the content as the routes' does: the brief's sheet must end on the crop rule, so nothing may follow it, and the three sections keep one rule; that row is a 69 px header band (three claim lines + dash) and the object starts under it. Artefact type = `--font-mono` at `--text-label` size (12 px), **no uppercase, letter-spacing 0** — the routes table's document setting — on an 18 px line (the steps' and lists' pitch); annotations `--ink-3`; the two sheet-like boxes use the page's one surface: 1 px `--hair-strong`, the inset top highlight, no radius, no shadow, transparent (nothing behind them to occlude). Brackets keep one meaning: `[ text ]` is a link, everywhere (nav, footer); unspaced brackets inside an artefact (`[T001]`, `[OpenCode CLI · DeepSeek]`) are the tool's own text, never a link — the transcript's `[…]` tails hide below 768 and stay on desktop. Section gaps: routes → brief `--s-24` (the brief's `padding-top`); brief → manifesto = the crop rule + the manifesto's own `--s-32`; manifesto → ladder = the manifesto's `--s-32` (the ladder has no top padding); ladder → record = the ladder's `padding-bottom --s-24`; record → footer: record `padding-bottom --s-24`, then the short rule. Keep-clear: the fragments layer is the first viewport (§7.5) and every new section starts below y = 1 140 at 1440×900 and below 2 032 at 390×844, so no new keep-clear boxes are needed; the `.claim` selector already in `main.ts` picks up the new claims on any taller viewport.

### 15.1 THE BRIEF (`section.brief-sheet`) — dense

The hero's `tasks.md` card (§5) opened to a full sheet and cut off by the page: the reader sees the contract itself, in the markdown the planner writes and the user reviews before any code is written. Claim: *one file, one brief, nothing else.* The two statements are marginalia — one at the sheet's head, one at its foot — so the commentary spans the object, and the column right of the sheet's lower half is the sheet's own margin, closed by the crop rule, not a void (the Phase 7 reviews' item).

| element | cols · rows (1440) | spec |
|---|---|---|
| eyebrow `h2` | 1–5 · 1 | `BEFORE ANY CODE` — derived `[MM:160]` "The user reviews tasks.md before any code is written" |
| claim `p.claim.dash` | 11–12 · 1–2 | `ONE FILE.` / `ONE BRIEF.` / `NOTHING ELSE.` |
| **sheet** `figure.sheet` | 1–5 · 2–4 | `margin-top --s-4`; the surface box with **no bottom border**; `padding: var(--s-6) var(--s-6) 0`; **`height: 707px; overflow: hidden`** — the crop (derivation below). Header = the hero card's, literally (§5): `figcaption` `tasks.md` (`--ink`, 500, 12 px) then `p.eyebrow` `TASK BRIEF` (`--ink-3`, `.08em`), both on 18 px lines; the `<pre>` under them carries the card's rule (`margin-top --s-2; padding-top --s-2; border-top: 1px solid var(--hair)`) and holds the block below, `white-space: pre-wrap`, 18 px lines. Ink inside it: `### …` heading lines `<b>` `--ink` 500; frontmatter keys (`id:` … `depends_on:`) `<span class="key">` `--ink-3`; the `---`, the code-fence lines and the `**` markers `<span class="mark">` `--ink-3` (`--ink-4` until 2026-09-09 — at 2.17:1 the marks read as smudges; `--ink-3` is 4.88:1 on the vignette's lightest stop and 5.09:1 on the canvas, so every text node in the sheet clears 4.5:1); everything else `--ink-2` |
| statement 1 `p.statement` | 7–10 · 2 | `grid-area: 2 / 7 / 3 / 11; margin-top: calc(var(--s-8) + var(--s-1))` — 36 px: its first baseline sits 1 px above the sheet's `tasks.md` header, level to the eye (at `--s-8` it was 5 px above — T-012 critic, applied in T-015); `--text-body`, `--ink-2`, `max-width: 34rem`: `The planner writes one brief per file. The implementer sees only its own brief — not the spec, not the plan, not the other tasks — and runs it in fresh context, with no memory of the last one.` |
| statement 2 `p.statement.dash` | 7–10 · 4 | `grid-area: 4 / 7 / 5 / 11; align-self: end; margin-top: var(--s-12); padding-bottom: var(--s-12)` — it ends at the sheet's foot with its dash 48 px above the crop rule (the hero seam's dash-to-rule distance, §1), beside `### Escalation` / `### Evidence`, the part of the contract it is about: `A brief that fails its checks never reaches an implementer. It reads CONTRACT BLOCKED until you retry, edit, or reject.` — derived `[TC:37]` (the deterministic quality report), `[TC:333]`; `CONTRACT BLOCKED` in `<b>` `--ink` 500 (the TUI panel's title, capture 5) |
| crop rule `hr.rule` | after the section | full content width, 1 px `--hair` — the sheet's cut line: its side hairlines meet the rule in two T-junctions, so the cut reads as the page's edge, not a rendering fault. The page's second full rule; the hero→routes rule (§1) stays the only *tight* seam |

Col 6 stays empty (the manifesto's col-10 device). The sheet's 5-column width is the hero's type column; at 1440 its inner measure is 485 px = 67 characters, so only the description wraps (to two lines). The block (`[PI:172-224]` shape and headings verbatim; content derived from README's example feature and the hero card, copy bank §A):

````
---
id: T002
title: Add the auth guard
action: create
file: src/auth/guard.ts
depends_on: [T001]
---

### Description
Guard a route with the JWT helper from T001. Reject a missing or expired token before the handler runs.

### Signature
```typescript
export function requireAuth(req: Request): Claims | AuthError
```

### Implementation Steps
1. Read the bearer token from the Authorization header
2. Verify it with verifyToken from src/auth/jwt.ts
3. Return the claims, or an AuthError naming the reason

### Tests
- requireAuth returns the claims for a valid token
- requireAuth rejects a missing token
- requireAuth rejects an expired token

### Scope
**In bounds:** src/auth/guard.ts
**Out of bounds:** src/auth/jwt.ts — do not change the helper

### Escalation
- Stop and ask if verifyToken's signature differs from this brief

### Evidence
- npm test -- src/auth passes

### Constraints
- No new dependency
````

Crop on the line grid: pre top = 24 (padding) + 18 (`tasks.md`) + 18 (`TASK BRIEF`) + 8 + 1 + 8 (the rule) = **77 px** from the figure's top, and every line is 18 px, so `height = 77 + 18 N` always cuts on a line boundary, never through glyphs. At 1440 the block is 39 lines (the description wraps once; 702 px, the sheet 779 px tall) and `### Evidence` is line 35: **`height: 707px`** (77 + 35 × 18) leaves Evidence's heading as the last whole line — the section the ladder and the record pay off — with `- npm test -- src/auth passes` and Constraints under the cut. Between reference widths the cut stays on the grid and the last line follows the wraps: at 1100 the measure is 49 characters, the block 47 lines, and line 35 is `**In bounds:** src/auth/guard.ts`. The block is never shorter than the crop at any width, so the object is always cut. Section height: 96 + 17 + 16 + 707 = **836 px** (measured 836.39 at 1440, T-015).

Tiers — 768–1099: eyebrow 1–9; claim `1 / 10 / 2 / 13`; sheet `2 / 1 / 5 / 8` (cols 1–7: 535 px at 1024 = 67 characters, the 1440 line map, so `### Evidence` is again line 35 and the height stays 707; at 768 the measure is 48 and line 35 is the in-bounds line); statement 1 `2 / 8 / 3 / 13`, statement 2 `4 / 8 / 5 / 13` (`align-self: end`) — the marginalia stay beside the sheet (375 px at 1024, 278 at 768). < 768: everything full width; the source order stays eyebrow, claim, sheet, statements, and the sheet takes `order: 1` so it renders last — eyebrow, claim, the two statements, then the sheet cut by the crop rule; in source position its hairlines ended in mid-air above statement 1 (T-012). The sheet **`height: 689px`** (77 + 34 × 18): at 390 the inner measure is 302 px = 41 characters, the block is 47 lines and `### Scope` is line 34 — the last whole line, the floor the reviews set (`### Escalation` would be 779 px on a page already ≈ 4 000 px tall); at 360 (37 characters) line 34 is the orphan `token`, so below 375 px the sheet is **`height: 653px`** (77 + 32 × 18) and the last whole line is `- requireAuth rejects a missing token`. Dark-canvas note: the crop's bottom is the `hr`, never a fade.

e2e (`extension.e2e.ts`, test `'the brief sheet is the tasks.md card opened and cropped'`): `figure.sheet` visible; its `figcaption` text is `tasks.md` and `figure.sheet .eyebrow` text is `TASK BRIEF`; `figure.sheet pre` text contains all eight `### ` headings and `id: T002`; `figure.sheet` `scrollHeight > clientHeight` (cropped); at 1440×900 its box height is 707 ± 1 and the `<b>` reading `### Evidence` has `bottom` = the figure's `bottom` ± 1 (the last whole line); at 390×844 the height is 689 ± 1 and `### Scope` is that line; `section.brief-sheet .statement` count = 2 and the second contains `CONTRACT BLOCKED`; `section.brief-sheet` `getAnimations({ subtree: true })` length = 0; the `hr` right after the section exists; at 390 the document has no horizontal overflow (page.e2e already asserts it).

### 15.2 THE LADDER (`section.ladder`) — dense, the proof

A run transcript typed in the TUI's own row grammar (`event-format.ts` `validate`, `dispatch.ts` `retry`, `preformatted-block.ts` `error` + meta + the rail, `activity-rows.ts` with `row-markers.ts` `├`/`└` — capture 1 is the reference frame, the unicode tier of `src/lib/glyphs.ts` the vocabulary): the page's task fails `test`, retries with the error attached, passes. The product mid-performance, in text. Claim: *not its own judge.*

| element | cols · rows (1440) | spec |
|---|---|---|
| eyebrow `h2` | 1–8 · 1 | `AFTER EVERY TASK` |
| claim `p.claim.dash` | 11–12 · 1–2 | `NOT ITS OWN JUDGE.` — derived `[MM:142]` "Correctness is not the implementer's to judge"; chosen over the bank's `IT NEVER CERTIFIES / ITS OWN WORK.` because every other rail claim on the page is a noun phrase and that one would have been the only sentence, and because it is statement 1's first clause compressed. 18 characters = 147 px at 1100, the rail's limit (`FEWER BLIND SPOTS.`). The rail is the claim alone — the config lines the first draft hung under it were config vocabulary, not the argument |
| **run block** `figure.run` | 1–8 · 2 | `margin-top --s-4`; the surface box, `padding --s-6`; `figcaption.bar` = the pipeline bar: `display: flex; justify-content: space-between; flex-wrap: wrap; column-gap --s-6`, `--ink-3`, the current phase `◉ Build` (`<span class="now">`) in `--ink-2`; the phases typed once — `span.phases`, `text-wrap: balance`, each marker glued to its label and each label to its connector with `&nbsp;`, so a wrap can only land after a `›` or `→` (the rungs' convention: connectors trail, never lead); until 2026-09-09 a second `span.phases--short` carried the TUI's narrow labels (`chrome-rows.ts` `RAIL_SHORT_LABEL`: `● Spc › ● Pln › ● Brf → ◉ Bld → ○ Vfy`) below 768, and the final critic found it undecodable on a page that never introduces the abbreviations — and `span.seats` holding three `white-space: nowrap` seat spans; a 1 px `--hair` rule under the bar (`padding-bottom --s-3`, `margin-bottom --s-3`); then `ol.transcript`, **thirteen** `li`, 18 px lines, `white-space: pre-wrap`, `list-style: none`; rows that open a block (2, 5, 10, 11, 13) carry `.gap` = `margin-top --s-4` — the TUI's blank spacer line (`build.ts` puts one before every top-level block after the first, the retry's activity batch included); the four callout rows (6–9) carry the TUI's rail as `border-left: 1px solid var(--ink-4); padding-left: 2ch` — a typed `│` does not connect at an 18 px pitch (its box is 15.8 px at 12 px), so the rail is drawn, not typed; row 8 is the callout's blank pad row (`li.pad`, `height: 18px`, empty) |
| rungs `ol.rungs` | 1–4 · 3–5 | `margin-top --s-8`; the **steps' grammar** (§4): number `--ink-3` in a 32 px cell, one continuous 1 px `--hair` vertical rule on the label cell (`padding-left --s-3`), label `--ink-2`, `--text-label` uppercase tracked, 18 px pitch, `white-space: nowrap`; under `06` a `<small>` in `--ink-3`, lowercase, tracking 0: `retry · a bigger worker · skip · pause · abort` (`[MM:150]`), typed `retry&nbsp;· a&nbsp;bigger&nbsp;worker&nbsp;· skip&nbsp;· pause&nbsp;· abort` so a wrap can only land after a `·` — the renderer's convention: separators trail, never lead, and an option never splits. With `text-wrap: balance` it sets as `retry · a bigger worker ·` / `skip · pause · abort` from 1100 down to 350 (three lines at 768, each trailing its `·`); without it 390 left `abort` alone (T-013 critic, applied in T-015). Between 768 and ≈ 815 the longest labels overrun cols 1–4 by ≤ 14 px into the gutter (`nowrap` kept; T-013). A sequence the docs number, so the numbers are earned; the rule makes it a ladder, not a third list |
| statement `p.statement` ×2 | 5–9 · 3, 4 | `margin-top: calc(var(--s-8) - var(--s-1))` on the first — 28 px, so its first baseline sits on rung 01's (at `--s-8` it was 4 px under — T-013 critic, applied in T-015) — and `--s-6` on the second; `--text-body`, `--ink-2`, `max-width 34rem`; the second closed by `.dash` |
| small print `p.fine` | 5–9 · 5 | `--text-label` size, sentence case, tracking 0, `--ink-3`, `margin-top --s-4`, `text-wrap: balance` (two even lines at 1440 — `…path where the` / `tool that wrote the code also reviews it.` — and no lone `reviews it.` at 800–840; T-013 critic, applied in T-015): `° That last tier is the one path where the tool that wrote the code also reviews it.` — the `°` is the sign-off mark (§4): rung 05 carries it because there the seat that signs off also wrote the code |

Rungs (`[MM:142-150]`, `[AR:281]`; the `°` is added): `01 TYPECHECK → LINT → TEST` · `02 RETRY ×3 WITH THE ERROR` · `03 MID-TIER MODEL` · `04 A HINT FROM THE PLANNER` · `05 THE PLANNER WRITES IT°` · `06 YOU DECIDE`. The rungs cannot live on the col-11 rail: at 1100 that rail is 147 px and the longest rungs (01, 02, 04 — 26 characters) are 232 px; cols 1–4 are 318.4 px there and 295.3 at 1024.

Statement 1: `Correctness is not the implementer's to judge. After every task splitbrief runs typecheck, lint and test in your project and stops at the first failure the task caused. A stage that was already red before the run does not count against it.` Statement 2 (derived `[AR:281]`, `[MM:146-150]`; `mid-tier` is typed with a non-breaking hyphen, U+2011, because at 800–840 the column broke it `mid-` / `tier` — T-013 critic, applied in T-015): `A failed task retries with the error attached, up to three times. Then it escalates: a mid-tier model if you have one, a hint from the planner, and finally the planner writes the code itself. If that fails too, you decide.` (owner's copy, 2026-09-09; `if you configured one` until then — the shorter clause sets the statement in four lines at 1440, not five)

The transcript (copy bank §B, derived from the renderer and capture 1; **four edits against the bank, each to the real grammar**: the bar's current phase is `◉ Build` — `statusInProgress` — not `●`; the error header is `error  test` — label, two-space `LABEL_META_GAP`, meta — not `error · test`; the failing line uses Vitest's `>` separator, the project's runner; and the block is the unicode tier of `glyphs.ts`, not the bank's ascii mix — a finished activity batch opens with `●` (`stageDone`), never `@`, its children are `├` then `└` (`treeBranch`, `treeLast`; a single child is `└`), and the error callout is a ruled block: the `│ ` rail on every row, a blank pad row, then `└ run npm test` (`preformatted-block.ts` `sourceFooterSegments`). The task header keeps `*` (`statusDone`, the marker a finished task wears). The bar's right half repeats the hero's seats (§4), model names only, as the TUI prints them; the tool label is the catalog's `OpenCode CLI`:

```
● Spec › ● Plan › ● Briefs → ◉ Build → ○ Verify      PLAN Fable · BUILD DeepSeek · REVIEW GPT-5.6
* T2 Add the auth guard  src/auth/guard.ts (create) · OpenCode CLI · DeepSeek

● Implementer activity  2 updates  [OpenCode CLI · DeepSeek]
  ├ Read    src/auth/jwt.ts
  └ Write   src/auth/guard.ts

validate  ✓ typecheck  ✓ lint  ✗ test
│ error  test
│ FAIL  src/auth/guard.test.ts > requireAuth > rejects an expired token
│
│ └ run npm test

retry  attempt 2/3

● Implementer activity  1 update  [OpenCode CLI · DeepSeek]
  └ Write   src/auth/guard.ts

validate  ✓ typecheck  ✓ lint  ✓ test
```

Markup of the hinge rows, pinned (T-011 greps the literals): row 6 `<li class="error"><b>error</b>  test</li>`; row 7 `<li class="output"><b>FAIL</b>  src/auth/guard.test.ts &gt; requireAuth &gt; rejects an expired token</li>`; row 9 `<li class="pointer"><span class="mark">└ </span><span class="dim">run npm test</span></li>`. The two seat tails — ` (create) · OpenCode CLI · DeepSeek` on row 1 and `  [OpenCode CLI · DeepSeek]` on rows 2 and 11 — are `<span class="tail dim">`.

Ink in the block — the TUI's tones mapped to §1: `*`, `●`, `├`, `└`, `validate`, the whole `retry  attempt 2/3` row (dispatch.ts prints it in one dim tone — T-013), the tails and `run npm test` are `textDim` → `--ink-3` (`.dim`); the rail `--ink-4`; the pointer's `└ ` (`.mark`) `--ink-3`, one ink with the activity rows' `├`/`└` (`--ink-4` until 2026-09-09 — two inks for one glyph; the sheet's marks moved with it, §15.1); the task title `<b>` `--ink` 500; the activity header text, the tool paths and the rest of the `FAIL` line `--ink-2`; every `✓` `--green` (one marker, one meaning — the card's ✓); **the hinge is one hot spot**: the `✗` (`.fail`), `error` and `FAIL` are all `--ink` weight 500 — three bold marks on three consecutive rows that read as one at squint, since the page has no red and adds no third accent; the stage names after the glyphs `--ink-2`. No byline under the block: the real byline names the phase *now*, and after `✓ test` that phase has moved on — a `Validating…` line would contradict the last row.

**Motion: none — decided no.** A typed reveal on viewport entry is a scroll-triggered transition: §7.4 rules it out, it is a different motion class from the page's continuous loops (the "pile of fade-ins" in disguise), and a proof that starts hidden fails the crawler/screenshot test (`shots.e2e.ts` finishes only the animations that exist at settle time). The proof is typographic: the `✗` then the three `✓`. §7 keeps its five items; no `src/features/ladder/`. Section height: **872 px** measured at 1440 with the `--s-24` bottom pad (896 at T-015; statement 2 lost a line with `if you have one`, 2026-09-09): 17 + 16 + 405 (block: bar 18 + rule 25 + 13 rows 234 + 5 gaps 80 + padding 48) + 28 + a five-line and a four-line statement + the small print — in the 34 rem measure statement 1 sets five lines, not the four the ≈ 756 estimate assumed; the rungs column is 126 px. The rows carry `text-wrap: pretty` (360 left `token` alone under the `FAIL` line — T-013).

Tiers — 768–1099: eyebrow 1–9; claim `1 / 10 / 2 / 13` (147 px in a 215 px rail at 1024, 157 at 768); block 1–12; rungs 1–4 (cols 1–4 = 295.3 px at 1024); statements and small print 5–9, and 6–10 below 840, where the rung labels overrun cols 1–4 (by 15 px at 768) and col 5 becomes the gutter. < 768: single column in source order — eyebrow, claim, block, rungs, statements, small print. The block's padding drops to `--s-3` (inner 326 px at 390 = 45 characters); the bar is three lines — the phases balance to `● Spec › ● Plan › ● Briefs →` / `◉ Build → ○ Verify`, the finished phases and then the current one opening the second line (36 px, measured at 390, 360 and 350), then the seats (44 characters, 317 px; at 360 the seat spans break at a ` · `, never inside a name); `.tail` is `display: none`, so rows 1, 2 and 11 end at the path or the count; every `li` hang-indents its continuation (`padding-left: 2ch; text-indent: -2ch`; the callout rows `padding-left: 4ch`, so their first line stays 2ch off the rail) — the only row that wraps at 390 is the `FAIL` line, into `> rejects an expired token` under `FAIL`; no wrapped row starts at column 0. No overflow at 390/360.

e2e (test `'the ladder transcript fails test, retries, and passes, in DOM order'`): `ol.transcript li` count = 13; of their texts, the index of the one containing `✗ test` < the index of `retry  attempt 2/3` < the index of the last one containing `✓ test`; the first `li` contains `Add the auth guard`; `li.error` `textContent` is `error  test`; `figure.run .bar` contains `◉ Build`; `ol.rungs li` count = 6 and the fifth ends with `°`; `section.ladder` `getAnimations({ subtree: true })` length = 0 (static — §7 unchanged); the small print starts with `°`; at 390×844 every `.tail` is hidden, `.phases` is 36 px tall and `◉ Build` starts at its left edge.

### 15.3 THE RECORD (`section.record`) — mid density

The session folder as the page's last object: a tree with air in it, the two commands that make one, and README's honest line under the evidence. Claim: *the evidence, on disk, in your repo.* Pays off `REAL EVIDENCE.` (§4) and `03 REAL EVIDENCE` (§9).

| element | cols · rows (1440) | spec |
|---|---|---|
| eyebrow `h2` | 1–7 · 1 | `AFTER THE RUN` — the timeline's last step, after `AFTER EVERY TASK` |
| claim `p.claim.dash` | 11–12 · 1–2 | `THE EVIDENCE.` / `ON DISK.` / `IN YOUR REPO.` — derived from the §4 claim (`REAL EVIDENCE.` is the hero's line; the article points at the file below) |
| statement `p.statement.dash` | 1–5 · 2 | `margin-top --s-4`; `--text-body`, `--ink-2`, `max-width 34rem`: `Every run is a session folder in your project. The state, the log, the briefs, the evidence and the review are files you can open, diff, and resume from.` |
| **tree** `pre.tree` | 1–7 · 3 | `margin-top --s-8`; no box — bare `--ink-2` text on the canvas, 12 px, 18 px lines, `white-space: pre`; **six** annotations, each a `<span class="note">` `--ink-3`, on `active`, `state.json`, `session.jsonl`, `tasks.md`, `evidence.json`, `review.md` — the files the statement names; the `//` is the 32nd character on every annotated line and the longest line is 78 characters (≤ 79), so cols 1–7 hold it at 1100 (575 px) |
| small print `p.fine.dash` | 1–5 · 4 | `margin-top --s-8`; `--text-label` size, sentence case, tracking 0, `--ink-3`, `text-wrap: balance` (four even lines at 1440; `worth it&nbsp;—` is glued, because at 768 a line opened with the dash — T-014 critic, applied in T-015): `Early software, pre-1.0. Cost is reported per run, never promised. Two numbers will decide whether the split is worth it — first-pass rate, and how much the cross-lab review catches that validation did not. Neither is measured yet.` (derived `[README:5,351,357-359]`; "validation" is README's own word — rung 01) then, as a block (`span.requirements`, `display: block`) with an `--s-2` breath above it, in the label style (uppercase, tracked, derived `[README:74,387]`; 441 px, inside cols 1–5 at 1440): `NODE 22+ · A GIT REPO WITH ONE COMMIT · MACOS AND LINUX` — each phrase is nbsp-glued and each `·` bound to the word before it, so a wrap can only land after a separator: one line down to ≈ 1130, two (`… ONE COMMIT ·` / `MACOS AND LINUX`) at 1100 and 390, three at 350; T-014's `nowrap` overran col 5 by 45 px at 1100 and was dropped (T-014 critic, applied in T-015) |
| commands `p.commands.dash` | 11–12 · 3 | `grid-area: 3 / 11 / 4 / 13; margin-top --s-8` — level with the tree's root line; two lines in the CTA's grammar (§4: `$` `--ink-3`, the command `--ink-2`, 12 px mono, 18 px lines), text, not links — the nav's `[ docs ]` routes to the reference: `$ splitbrief init` (`[README:106]`) and `$ splitbrief start "add user auth"` (derived `[README:107]`, the job shortened to the tree's own session name, `add-user-auth`). Each line `white-space: pre-wrap; padding-left: 2ch; text-indent: -2ch`, so on the rail (199 px at 1440, 147 at 1100) the second command sets as `$ splitbrief start` (130 px) with `"add user auth"` hanging under `splitbrief`: a hanging indent — the page's own typography; the quotes keep it one command (`text-wrap: balance` on each line makes the hang: the natural wrap at 199 / 215 px split the quoted job — T-014). Below 768 the 350 px column holds it on one line |

The tree (`[README:113-123]` completed from `[FE:200]` and `[MM:102-103]`; notes `[MM:98-99]`, `[TC:339]`, derived `[README:115]` for `active`, `[MM:26]` for `tasks.md` and `[FE:144]` for `review.md`, ≤ 45 characters each so no line passes 79):

```
.splitbrief/
├── config.yaml
├── active                     // the current session
└── sessions/
    └── 2026-04-14-add-user-auth/
        ├── state.json         // the source of truth for resume
        ├── session.jsonl      // every event and message, append-only
        ├── research.md
        ├── spec.md
        ├── plan.md
        ├── tasks.md           // every brief, one per file
        ├── evidence.json      // what was to be proved, and what was observed
        ├── review.md          // the reviewer's read
        ├── summary.json
        └── snapshots/
```

The modes annotation the research folded in (`--mode quick · standard · speckit …`) is cut: 238 px does not fit the rail and it is a knob, not the argument; the four bracket links of the first draft are cut for the same reason as the ladder's config rail — an index is documentation, and the nav already links it. Section height: **664 px** measured at 1440 (T-015; 17 + 16 + 89 + 32 + 270 for 15 lines + 32 + 112 of small print + 96); the rail holds 69 px of claim and 71 px of commands (three 18 px lines + the dash), 209 px from the eyebrow row to the commands' dash, level with the tree's `sessions/` line — under it the right column runs quiet to the short rule, as the footer's right column does.

Tiers — 768–1099: eyebrow 1–9; claim `1 / 10 / 2 / 13`; statement 1–8; tree 1–12 (934 px at 1024, 700 at 768 — 97 characters); small print 1–8; commands `4 / 10 / 5 / 13` (`margin-top --s-8`, beside the small print; `$ splitbrief start` 130 px in 215 / 157 px). < 768: single column in source order — eyebrow, claim, statement, tree, small print, commands; the tree keeps `white-space: pre` on its names and glyphs, and each `.note` becomes `display: block; white-space: normal; margin-left: 12ch; padding-left: 3ch; text-indent: -3ch` — the annotation drops under its file with its `//` under the file name (the design's `--s-12` sat left of the deep files' branch glyph — T-014) and a wrapped note's second line hangs under its first word (T-014 critic, applied in T-015); each note's newline sits inside its span, so the block paints no blank line and the tree's text is byte-identical — so the 350 px column never overflows (the alignment spaces before the note trail invisibly); the page's last text before the footer is `$ splitbrief start "add user auth"` on one line, and the footer's `[ github.com/b4r7x/splitbrief ]` is the next bracket — the hero's two command grammars (CTA, nav) close the page as they opened it.

e2e (test `'the record lists the session folder and the two commands'`): `pre.tree` text starts with `.splitbrief/` and contains `evidence.json`, `review.md`, `snapshots/`; `pre.tree .note` count = 6; `.record .commands` text contains `$ splitbrief init` and `splitbrief start "add user auth"`, and `.record .commands a` count = 0; `.record .fine` text contains `Neither is measured yet.` and `MACOS AND LINUX`; `section.record` `getAnimations({ subtree: true })` length = 0. Rail test (`'every new claim sits on the col-11 rail'`, 1440×900): the `left` of `.brief-sheet .claim`, `.ladder .claim` and `.record .claim` each equals `.routes .claim`'s `left` ± 1 px.

### 15.4 Arc, seams, heights

| section | 1440 height | density | shape |
|---|---|---|---|
| nav + hero | 1 140 | dense, airy lower-left | glyph field |
| routes | 227 | dense | table |
| brief | 836 (+ the 1 px crop rule) | dense | tall cropped sheet, marginalia |
| manifesto | 407 (`padding-top` 128, untouched) | breath | wide type |
| ladder | 872 (with the `--s-24` pad) | dense | terminal block + rungs |
| record | 664 | mid | tree with air |
| footer | 215 (after the 1 px short rule) | whisper | — |

Every height measured at 1440×900 on 2026-09-09 (the final fix; `getBoundingClientRect` on `main > section` and `footer`): 96 + 1 043.97 (1 019.97 before the lede's fourth line) · 227.39 · 836.39 · 407.13 · 872.17 (896.17 before statement 2 lost a line) · 664.34 · 214.69.

Page 4 365 px at 1440 (1 967 before §15; the lede's extra line and the statement's lost one cancel; 7 472 at 390). Section gaps at 1440, last ink to next ink: hero → rule 48 · rule → routes 64 · routes → brief 96 · brief → crop rule 0 (the sheet and statement 2 both end on it) · rule → manifesto 128 · manifesto → ladder 128 · ladder → record 96 · record → short rule 96 · short rule → footer 64 — every one on the §1 scale, none invented; at 390 the box gaps are the same list (the hero's last ink, the reviewer's skirt on the compact stage, sits 42 px above the rule inside the 48 px pad). Falsifier result: the 20 % thumbnail reads dense → dense → dense → breath → dense → mid → whisper, and the three blocks before the breath are three silhouettes — a glyph field, a short table, a tall cropped sheet — so the routes and the sheet do not fuse (T-014 critic, T-015 thumbnail) and the brief keeps its `--s-24` top gap. Running motif: the eyebrow timeline — `BEFORE ANY CODE` → `AFTER EVERY TASK` → `AFTER THE RUN` — one clock read across the three seams, on top of the page's dash, `°` and bracket motifs (§1). Seams: hero → routes the tight rule (§1); routes → brief the shared eyebrow grammar and the rail, and the sheet is the hero card reopened — the card's own header, `tasks.md` / `TASK BRIEF` / hairline, inside it; brief → manifesto the crop rule with the sheet's hairlines running into it; manifesto → ladder the paragraph's `typecheck, lint, test — retries, escalates` answered by rung 01 and the `retry` row, no rule; ladder → record the timeline's last two steps and the `--ink-3` mono texture (transcript → tree); record → footer the short rule with a `$` line above it and a bracket link below it. Uniformity check: the three artefacts are a sheet in a box, a transcript in a box and a bare tree — two boxes, not three; the rungs reuse the steps' rule; the manifesto stays the only numbered claims list; the marginalia device (a note at the head and one at the foot of the object) appears twice — the brief's statements, the record's claim and commands — never a third time. Hot spots below the fold: the green `✓`s and the one bold hinge (`✗` · `error` · `FAIL`) in the ladder; nothing else brighter than `--ink`.
