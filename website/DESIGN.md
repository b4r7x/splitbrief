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
| `--text-display` | `clamp(3.25rem, 5.4vw, 4.9rem)` — 52→78.4px (77.76px at 1440, cap ≈ 58px; the reference implies 65); line-height `1`; letter-spacing `0`; weight 400; `TWO MODELS` must fit the 5-column measure (533px at 1440) with no `nowrap` masking — measured 519.9px at opsz 20; the 4.9rem ceiling keeps it inside the column above 1450px (at 84px it measures 549px) and 5.4vw keeps ≥ 9px of margin down to the 1100px tier edge |
| `--text-wide` | `clamp(1.375rem, 2.1vw, 1.9rem)` — the "// YOU DESCRIBE" block; line-height `1.25`; letter-spacing `.04em` |
| `--text-body` | `.9375rem` (15px); line-height `1.6` — hero paragraph, manifesto paragraph |
| `--text-label` | `.75rem` (12px); line-height `1.45`; letter-spacing `.08em`; uppercase — every annotation, nav link, step, works-with, list |
| `--text-micro` | `.6875rem` (11px) — diagram side labels, brief card body, footer |
| `--text-cta` | `.875rem` (14px) — the install line |

Fonts load from Google Fonts: `Bodoni+Moda:opsz,wght@6..96,400`, `JetBrains+Mono:wght@400;500`, `Space+Mono:wght@400` with `display=swap`, `<link rel="preconnect">` to `fonts.googleapis.com` and `fonts.gstatic.com` (`crossorigin`). Each family gets a size-adjusted local fallback `@font-face` (`size-adjust`, `ascent-override`, `descent-override`) so the swap does not shift layout; the metrics are calibrated by measuring the real face against the fallback on the strings the page actually sets (the display face is calibrated on the uppercase h1 against Georgia; re-measured after every face change and recorded in base.css). Headings `text-wrap: balance`; paragraphs `text-wrap: pretty`; numeric columns `font-variant-numeric: tabular-nums`.

### Space & grid

- Scale: `--s-1: 4px · --s-2: 8px · --s-3: 12px · --s-4: 16px · --s-6: 24px · --s-8: 32px · --s-12: 48px · --s-16: 64px · --s-24: 96px · --s-32: 128px`. No other values.
- Page gutter `--gutter: clamp(20px, 4.4vw, 64px)`. Content max-width `1312px` (1440 − 2×64), centred.
- Grid: 12 columns, `column-gap: var(--s-6)`. Hero left = cols 1–5, hero diagram = cols 6–12. Routes table spans 1–9, its claim sits in 10–12. Manifesto: heading 1–4, paragraph 5–9, list 10–12. Footer: 1–3 / 5–8 / 10–12.
- Section gap `--s-24` (96px); the manifesto is the breath: `--s-32` above and below.
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
  <section class="manifesto">   wide heading · paragraph · 01–05 list
  <hr class="rule rule--short">
</main>
<footer class="foot">           left claim · centre tick + link · right claim
```

Semantic HTML: `header/nav/main/section/footer`, `h1` is the hero statement, `h2`s are visually the eyebrows (`EXAMPLE ROUTES`, the wide manifesto heading), the routes are a real `<table>` with `<caption>` (visually hidden) and `scope="col"` headers, the brief card is a `<figure>` with `<figcaption>`, the ghosts are `<canvas role="img" aria-label="…">`, each followed by a `<pre class="ghost-fallback" aria-hidden="true">` holding the same character art (frame 0, printed by `tools/render-static.ts`). `<html class="no-js">`; a one-line inline `<script>` in `<head>` (`document.documentElement.classList.replace('no-js','js')`) swaps the class before the body parses — module scripts defer, so doing it in `main.ts` would flash the `<pre>` fallbacks; `.no-js canvas` is hidden and `.js .ghost-fallback` is hidden, so exactly one of the pair renders. Reduced motion keeps the canvas (frame 0) — the `<pre>` is the no-JS path only.

## 3. Nav (`header.nav`)

Height 96px (padding-block `--s-8`). Four items on one row, baseline-aligned:

1. **Wordmark** `splitbrief°` — `--font-mono`, 22px, weight 500, `--ink`; the `°` is a `<sup>` in `--ink-3` at 60% size, `top: -.6em`. Links to `#top`.
2. **Tagline** (cols 3–4, starts at ~col 3): three lines, `--text-label`, `--ink-3`: `ONE PLANS.` / `ONE EXECUTES.` / `ONE CONTRACT.`
3. **Links** (right-aligned, before the mark): `[ docs ]` → `https://github.com/b4r7x/splitbrief/tree/main/docs`, `[ github ]` → `https://github.com/b4r7x/splitbrief`. `--text-label`, `--ink-2`; brackets are part of the text; hover: brackets turn `--blue`, text `--ink`; `text-decoration: none`; visible focus ring.
4. **9-dot mark** — a 3×3 grid of 3px dots, 20×20 box, `--ink-2`; pure ornament (`aria-hidden`, a `<span>`, not a button). Sits at the right gutter.

## 4. Hero (`section.hero`)

Grid 12 columns; `min-height: calc(100vh - 96px)`; `padding-block: var(--s-6) var(--s-16)`.

### Left column (cols 1–5) — vertical order, five rows, with the y-positions the reference implies at 1440 (nav bottom = 0)

| y | element | spec |
|---|---|---|
| 24 | **Steps** | three rows: `01 │ PLAN`, `02 │ EXECUTE`, `03 │ REVIEW`. Number `--ink-3`, one continuous 1px `--hair` vertical rule spanning the three rows between number and label (`border-left` on the label cell, `padding-left: var(--s-3)`, number column 32px wide), label `--ink-2`. `--text-label`. Row pitch 18px. |
| 189 | **Headline** `h1` | margin-top `--s-24`; four lines, `--text-display`, `--font-display`: `TWO MODELS` / `ARE GOOD.` (this line `--ink-4`) / *stanza gap `--s-24`* / `A SYSTEM` / `IS BETTER.` Each line a `<span class="line">` (display block) so the muted line and the stanza gap are styleable; the h1 text reads "Two models are good. A system is better." to assistive tech (use `aria-label` on the h1 to avoid the visual line breaks being read as pauses). No uppercase transform — the source text is uppercase. |
| 624 | **Lede** `p` | three lines, `--text-body`, `--ink-2`, `max-width: 34rem`: `**splitbrief** runs two coding tools against one job. The stronger one plans and reviews, the cheaper one executes — and splitbrief holds the contract between them.` — first word `<strong>` in `--ink`, weight 500. Closed by `.dash`. |
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
| **route A: planner → card** | horizontal from the planner's right rim (27.8%, 46%) to the card's left edge (33.5%, 46%) | `--ink-3`, `1px dashed` (4px on / 4px off) |
| **route B: card → implementer** | horizontal from the card's right edge (44.5%, 46%) to the implementer's left rim (55%, 46%) — it enters the ghost's lower third | same stroke, straight |
| **route C: card → reviewer** | from the card's bottom centre (39%, 52%) down to (39%, 60%), right to (49%, 60%), down to (49%, 72%), right to the reviewer's left rim (58%, 72%) | same stroke; corners are hard 90°; no curves anywhere |
| **tick + label: planner** | tick 1px × 28px `--ink-3`, top-anchored at (14%, 18%) (ends 21.3%, the crown starts at 24%); label right of the tick, `--text-label` `--ink`: `CLAUDE` / `+ FABLE` | |
| **tick + label: implementer** | tick top-anchored at (67%, 18%); label `OPENCODE` / `+ DEEPSEEK` | |
| **tick + label: reviewer** | tick top-anchored at (76%, 55%) (below the implementer's bottom at 53%, above-right of the reviewer's crown); label `CODEX` / `+ GPT-5.6°` | the `°` marks the seat that signs off |
| **seat label: planner** | top-left at (6%, 60%) — below-left of the ghost (bottom 56%) | `PLAN` (`--ink`) then `ANALYZE` / `DECOMPOSE` / `ROUTE` (`--ink-3`), `--text-micro`; a 1px×12px tick above it; closed by `.dash` |
| **seat label: implementer** | top-left at (84%, 36%) — right of the ghost (right rim 79%) | `IMPLEMENT` / `GENERATE` / `ITERATE` / `TEST` |
| **seat label: reviewer** | top-left at (82%, 76%) — right of the ghost (right rim 78%) | `REVIEW` / `READ` / `EVALUATE` / `CONFIRM` |
| **`+` crosshair** | centre (30%, 70%) — moved from (26%, 63%) on 2026-09-07 (fix cycle 1), where it sat on the PLAN label's right edge | `--ink-3`, 14px — drafting mark |
| **rain** | two seeded glyph columns, one per lab seat, centred on the tick's x (planner 14%, implementer 67%), 6 cells (42px) wide, from y 6% down to y 17.5% — 9 rows of 11px; the column ends 0.5% above the tick top, so the tick reads as the funnel that carries the rain into the crown | `.`/`:` glyphs, `--ink-4`, `--text-micro`, placed by `features/diagram/rain.ts` (`rainPoints`, `lib/noise` seeded): a cell lights when its hash falls under a share that tapers from 36% on the top row to 20% on the bottom row, so at most 30% of a column's 54 cells are lit (planner 10, implementer 15; the bottom share was 12% until 2026-09-07, Phase 4 — the Phase 3 critic measured the lowest rows as empty, so the funnel into the tick was not perceptible on a still frame). Replaced the 2px dotted gradient line on 2026-09-07 (fix cycle 1): a single dotted line read as a leader from the claim's dash down to OPENCODE, not as weather. Placed by JS like the scatter, so the no-js page has no rain. → part of the motion concept (§7); the column never touches the tick or its label |
| **scatter** | ~60 `.`/`:`/`·` glyphs in a loose diagonal band from (0%, 6%) to (24%, 26%), a light trail of ≤ 30 `.`/`:` glyphs across the lower-left quarter (x 0–39%, y 60–100%; more than 4× sparser than the band, clear of the PLAN label, the `+` and every other keep-clear box), plus a sparse halo (≤ 40 glyphs) within 30px of each ghost's rim | `--ink-4`, generated by `features/diagram/scatter.ts` with a fixed seed so renders are deterministic; anything outside the stage is clipped by the box. The trail was added 2026-09-07 (fix cycle 1): the quarter under the planner was a void that pointed at nothing |

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

1. **Breath** — the ghosts' density field (§6). Calm planner, quick implementer, slow reviewer. The loops run on `diagram/ticker.ts` (`createTicker(canvas, rate, onTick)`: planner and implementer 12 fps, reviewer 8 fps; paused while the tab is hidden or the canvas is off-screen). Each ghost also **reacts to the packet** through the `Pose` it hands `density()` every tick (`pose.ts`, pure, from the timeline's clock): *gaze* — the pupils point at the packet: `c` = −1 / 0 / +1 by whether it is left of, within, or right of the middle half of the ghost's box, `r` = −1 / 0 / +1 against a band 40% of the box height either side of the eye row, and the seat's own gaze (§6) returns whenever nothing is in flight — so all three sit level while the brief runs planner → card → implementer, the planner and the implementer drop their gaze one row while it goes down to review (3.4–7.5 s), the reviewer meets it level on the last leg, and everyone looks back toward the card at rest (the ±25% band measured 2026-09-07 kept every ghost looking down for 84% of the loop, because both routes run below the eyes); *lift* — the rim cells (edge falloff ×0.45) rise to ×0.9 over the 0.6 s before the packet touches the seat and settle back over 0.3 s (planner, bracing before it emits at t = 0), 0.5 s (implementer) or 0.6 s (reviewer); *gain* — the reviewer alone multiplies its body ×1.15 for 0.4 s when the packet lands (the confirm); *jolt* — the implementer alone shifts one body row for its 90 ms glitch the instant the packet lands. The per-seat moments are `timeline.ts` `CUES` (planner 0 s, implementer 3.4 s, reviewer 7.4 s).
2. **Rain** — the seeded glyph columns above planner and implementer (§4) drift downward at 14 px/s: `rain.ts` `rainPhase(t)` turns the elapsed time into a whole-pixel translate of the column (0–10 px) and a *generation* every 11 px; each generation moves every surviving glyph one row down (its lit test is re-evaluated at the new row's share, so the fall thins toward the tick and the taper survives the motion) and re-seeds the top row. Driven from `diagram/mount.ts` by the same ticker at 14 Hz. The rain is glyphs, not a gradient, so it is no longer a `background-position` shift.
3. **Packet** — two `--white-spark` `■` elements (7×7px), `.packet--impl` and `.packet--rev`, on one shared 9 s timeline (`timeline.ts` `PERIOD`; one WAAPI animation per element, infinite, `fill: both`): t 0–1.2 s `.packet--impl` fades in over 120 ms and travels route A from 8 px inside the planner's rim (it emerges between the rim glyphs) to the card's left edge · 1.2–1.8 s it crosses the card **behind** it (the card occludes, §5) while the card's outline takes the packet's colour — `border-color` `--hair-strong` → `--white-spark` over 100 ms, held to 1.8 s, back by 1.9 s; the `T2 … ▸` row already rests at `--ink` (§5) and does not change · 1.8–3.4 s it travels route B to 8 px inside the implementer's rim, then fades out over 120 ms while the implementer's tick flares `--ink-3` → `--white-spark` (50 ms up, held 0.4 s, back over 100 ms) and its seat list `GENERATE / ITERATE / TEST` lifts `--ink-3` → `--ink-2` on the same envelope · at 3.4 s `.packet--rev` appears 8 px above the card's bottom centre and travels route C (4.0 s, to 7.4 s — route C is 316 stage px, so all three legs move at 36–80 px/s and read as one unhurried object), then fades out while the reviewer's tick and seat list answer the same way · 7.4–9 s rest (both hidden). The tick labels themselves stay `--ink`: a flash to `--white-spark` measured invisible on 2026-09-07 (a 3% step), so the tick carries it. Each packet tows a **wake**: three `--white-spark` squares of 5, 4 and 3 px at opacity .45, .30 and .15 riding the same path and keyframes 0.12, 0.24 and 0.36 s behind it (a WAAPI `delay`), so the tail stretches 4–29 px at the legs' speeds and closes up where the packet stops. Implemented in `features/diagram/packet.ts` as `offset-path: path(...)` with `offset-distance` keyframes — `route-geometry.ts` builds each path as the exact polyline of its route in stage px at 760×860 — so packets and wakes stay glued to the lines under `transform: scale()`. The timeline starts at boot, so on first load the planner's leg overlaps the diagram's entrance: the system is already running when it appears.
4. **Entrance** — on load only: `nav` (0) · steps, the `/` mark and the claim (1) · `TWO MODELS` (2) · `ARE GOOD.` (3) · `A SYSTEM` and the diagram (4) · `IS BETTER.` (5) · lede (6) · CTA (7) · works-with (8) fade from `opacity 0; translate 0 8px` to rest, each starting at its index × 60 ms, 480 ms, `ease-out`, `both` — so the diagram fades in as one unit after 240 ms. The fragments layer fades in over 480 ms once placed. No scroll-triggered animation anywhere; the routes/manifesto sections are static.
5. **Background fragments** — `features/fragments/mount.ts` places 28 mono strings from the pool below across the viewport (`position: fixed` layer behind content, `z-index: -1`, `--ink-4`, 11px, opacity `.18–.35`), each hovering: it drifts upward 120px over 14–28s, fading in over the first second and out over the last 2s, and restarts at its origin (no wrapping, no infinite scroll); each starts mid-cycle at its own seeded phase (a negative `delay`), so nothing moves in unison. Pool: `brief -> implementer`, `typecheck · lint · test`, `retry(3) -> escalate`, `const brief = compile(spec)`, `while (red) retry()`, `promote(diff)`, `evidence.jsonl`, `real software`, `lower spend`, `fewer blind spots`, `one file per brief`, `0x2f 0x62 0x72`, `[ 3 / 7 ]`, `∴`, `//`, `→`, `T1 ✓`, `T2 ▸`, `hash ok`, `worktree` (20 strings; the first eight repeat once). Origins, drift durations, opacities and phases are drawn from `lib/noise` `hash` with seed 23 (no `Math.random` anywhere in `src/`), so the layout is identical on every render and the screenshots are reproducible. Fragments never overlap the type or the diagram's marks: the placer rejects any origin whose box **plus its full 120px travel band** (6 px margin) intersects a keep-clear box — the headline, lede and CTA the concept demands, and also the wordmark, tagline, links, 9-dot mark, the steps' cells, the `/` mark, the claims, works-with, the three canvases, the tick labels, the seat labels, the card, the three routes and the `+` — or a band already taken by another fragment, so no two fragments ever cross. `main.ts` measures the boxes once after fonts load and again on `resize`, **at rest**: every finite animation (the entrance) is sampled at its end and restored inside the same task, so the 8 px entrance offset never shifts a placement (it moved the count between 27 and 28 until 2026-09-07). Origins may sit up to one travel (120 px) below the fold, so the lowest fragments rise into view; the search draws up to 2000 seeded candidates per string — at 1440×900 the type-free area holds exactly 28 non-crossing bands (400 candidates found 24; 8000 found no more than 2000). Opacity never exceeds `.35`. At 1440×900 the header band carries eight of the 28: the count, not the placer, is the lever if the header should be quieter.

`prefers-reduced-motion: reduce` → 1 renders frame 0 only (the seat's own gaze, no lift), 2/3/5 are off (`animation: none`; both packets and their wakes `display: none`; `main.ts` calls `stop()` on the diagram and the fragments, which cancels every WAAPI animation — the card outline, ticks and seat lists sit at rest — and leaves the fragments static at their origins), 4 is replaced by instant visibility. `@media (prefers-reduced-motion)` lives in `src/styles/motion.css` alongside the keyframes; `lib/reduced-motion.ts` owns the single `matchMedia` and its `change` subscription, and `main.ts` starts or stops both features live when it fires.

## 8. Routes section (`section.routes`)

Eyebrow `EXAMPLE ROUTES` (`h2`, `--text-label`, `--ink-3`). Table `--text-label` (12px, no uppercase transform — model names are lowercase here, as in the reference), row pitch 26px, `--ink-2` cells, arrows `→` in `--ink-3`, comment column `// feature` in `--ink-3`. Five columns: `#` (32px) · plan · implement · review · goal. The `→` arrows are CSS `::after` content on the plan and implement cells (`--ink-3`, `padding-inline`), so the DOM has exactly five columns and five visually hidden `scope="col"` headers (`#`, `PLAN`, `IMPLEMENT`, `REVIEW`, `GOAL`). The review cell's model carries the `°` sign-off mark.

| # | plan | implement | review | goal |
|---|---|---|---|---|
| 01 | claude + fable | opencode + deepseek | codex + gpt-5.6° | // feature |
| 02 | codex + gpt-5.6 | ollama + qwen3-coder | claude + sonnet° | // refactor |
| 03 | claude + sonnet | opencode + qwen3 | codex + gpt-5-codex° | // bugfix |
| 04 | cursor + gpt-5.6 | lm studio + devstral | claude + opus° | // docs |
| 05 | claude + opus | copilot + gpt-5-mini | codex + gpt-5.6° | // tests |

Right claim (cols 10–12, aligned with the eyebrow): `DIFFERENT LABS.` / `ONE SHARED BRIEF.` — `--text-label`, `--ink`; closed by `.dash`.

## 9. Manifesto (`section.manifesto`) — the breath

Three columns, `padding-block: var(--s-32)`:

- **Heading** (cols 1–4, `h2`): `// YOU DESCRIBE` / `THE GOAL.` / `SPLITBRIEF HOLDS` / `THE REST.` — `--font-wide`, `--text-wide`, `--ink-3`; `//` in `--ink-4`; `SPLITBRIEF` in `--ink-2`. Four lines, `text-wrap: balance` off (lines are explicit).
- **Paragraph** (cols 5–9): `From research to Task Briefs to review, the stronger tool thinks and the cheaper one types. splitbrief validates every task — typecheck, lint, test — retries, escalates, and keeps the evidence.` `--text-body`, `--ink-2`, `max-width: 38rem`. Closed by `.dash`.
- **List** (cols 10–12, `ol`): `01 HIGHER QUALITY` / `02 LOWER SPEND` / `03 REAL EVIDENCE` / `04 YOUR TOOLS` / `05 YOUR RULES` — `--text-label`; numbers `--ink-3`, labels `--ink-2`; pitch 18px. Closed by `.dash`.

## 10. Footer (`footer.foot`)

Preceded by a short rule (cols 3–10). Three columns, `--text-label`:

- left (cols 1–3): `BUILT FOR` / `PEOPLE WHO` / `ACTUALLY BUILD` — `--ink-2`; `.dash`.
- centre (cols 5–8): a 1px × 48px vertical tick centred, then `[ github.com/b4r7x/splitbrief ]` as a link (same hover/focus rules as nav links), `--ink-3`.
- right (cols 10–12): `SAME TOOLS.` / `BETTER OUTPUT.` — `--ink`; `.dash`.

`padding-block: var(--s-16) var(--s-12)`.

## 11. Responsive tiers

| width | layout |
|---|---|
| ≥ 1100 | as above; the diagram box scales fluidly between 584px and 760px wide via `width: 100%` on the 7-column span; ghosts keep their pixel size (they are placed by %) — at 584px the scale factor is ~0.77, applied with `transform: scale()` on an inner 760×860 stage |
| 768–1099 | hero stacks: left column full width (headline up to `7.75rem` still fits at 1024), diagram below at full content width, stage scaled to fit; routes table keeps all columns; manifesto becomes 2 rows (heading full width, then paragraph + list side by side); footer 3 columns |
| < 768 (390 target) | nav: wordmark + links only, tagline hidden (`display: none`, it is decorative). Headline `--text-display` bottoms out at 68px. **Diagram compact tier**: the 760×860 stage is replaced by a vertical 350×980 stage scaled by `min(1, contentWidth / 350)` (so at 360 viewport with 20px gutters it renders at 0.914) — planner (centre 50%, 16%), card (50%, 42%), implementer (50%, 62%), reviewer (50%, 88%), routes are straight vertical dashed lines through the card, tick labels sit to the right of each ghost, seat labels to the left; same canvases, same 7×11 cell grid before the stage's uniform fit-scale (1.0 at 390). Works-with becomes two columns. Routes table: index + plan / implement / review stacked as three lines per row with the goal comment as the first line (`// feature`), arrows become `↓` on their own line. Manifesto single column. Footer single column, centred tick. No horizontal scroll at 390px or 360px. |

Container queries (`@container hero (max-width: …)`) drive the diagram tier; media queries drive the page grid. Touch targets ≥ 44px for the CTA and links (padding, not font size).

## 12. Craft floor (checked on screenshots, every phase)

- headline-to-body ≥ 4:1 (124/15 ✓); nav ink ≈ 55% (`--ink-3`) so it recedes
- exactly two accents, each ≤ 3 element types (blue: planner ghost, planner labels/ticks, focus/copy flash · green: implementer ghost, implementer labels, the `✓`)
- one atmosphere (vignette + grain), nowhere else
- no orphans under any headline line; no mid-URL breaks in the footer link (`overflow-wrap: anywhere` only there)
- every interactive element: visible 2px focus ring, hover state, `cursor: pointer`
- `::selection` styled; `<html lang="en">`; `<meta name="theme-color" content="#0b0c0e">`; `<title>splitbrief — one plans, one executes, one contract</title>`; `<meta name="description">` = the lede
- Lighthouse a11y ≥ 95, performance ≥ 95 (no assets besides fonts; built JS ≤ 90 KB gzipped including any motion library, ≤ 12 KB gzipped of our own code)

## 13. Stack and file map (sota-structure)

**Stack:** Vite (vanilla TypeScript template, `base: './'` so `dist/` deploys under any path — it is served over HTTP, never opened from `file://`, which Vite's module scripts do not support; build → `dist/`) · optional `gsap` as the only runtime dependency, imported per module (`import { gsap } from 'gsap'`), tree-shaken, used only inside `src/features/**` · TypeScript strict (`moduleResolution: "bundler"`, extensionless imports — the Vite convention; this package is independent of the CLI's NodeNext config) · Vitest for unit tests, colocated · `@playwright/test` with `channel: 'chrome'` (the installed Google Chrome, no browser download) for e2e, screenshots, and motion assertions, running against `vite preview` · Biome for lint + format. No UI framework; `dependencies` holds at most `gsap`.

```
website/
  package.json               private; scripts: dev · build · preview · typecheck · lint · format · test · e2e · shots · render-static
  tsconfig.json              strict, bundler resolution, noUncheckedIndexedAccess, exactOptionalPropertyTypes, types: ["vite/client"]
  vite.config.ts             base './' (host-agnostic asset paths), build.target 'es2022', preview port 4173
  vitest.config.ts           include src/**/*.test.ts, environment 'node' (pure functions only — DOM code is e2e-tested)
  playwright.config.ts       channel 'chrome', webServer 'npm run build && npm run preview', baseURL http://localhost:4173, testDir tests/e2e, testMatch **/*.e2e.ts
  biome.json                 same style as the repo root (2 spaces, 100 cols, single quotes, kebab-case filenames), includes src/ tests/ tools/ and the config files
  index.html                 the page — Vite entry; semantic skeleton, all copy, canvases, <pre class="ghost-fallback"> siblings shown only under html.no-js
  DESIGN.md                  this sheet
  README.md                  ≤ 10 lines: install, dev, build, test, e2e, shots, design-sheet pointer
  .gitignore                 test-results/ (Playwright's outputDir); dist/ and node_modules/ are already covered by the root ignore
  src/
    main.ts                  boot: mountCopyButton · mountDiagram · mountFragments (the no-js → js swap is the inline head script, §2); measures the fragments' keep-clear boxes at rest (§7.5) and starts/stops both motion features from lib/reduced-motion
    styles/                  the shared stylesheet tier (a technical-type dir is sanctioned in the shared tier of a tiny app)
      main.css               @layer tokens, base, layout, sections, motion; then @import url(...) layer(...) for every stylesheet below, in order
      tokens.css             §1 custom properties only
      base.css               @font-face size-adjusted fallbacks, reset, body (background-color + background-image), grain, ::selection, :focus-visible, .dash, .rule, .visually-hidden, .no-js/.js switches
      nav.css                §3
      hero.css               §4 left column, claim, works-with; the hero grid (the CTA box lives in cta.css)
      cta.css                  §4 CTA: the box, the two-state label grid (idle + notice stacked in one cell), the copy glyph, the copied flash
      diagram.css            §4 right column, stage + fit-scale, routes, ticks, labels, rain, scatter, §11 compact tier (container query)
      brief.css              §5 card (split out of diagram.css on 2026-09-07 — the stage sheet alone sits near the 200-line cap)
      routes.css             §8
      manifesto.css          §9
      footer.css             §10
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
        scatter.ts           seeded band + lower-left trail + halo glyph placement → DocumentFragment
        scatter.test.ts      determinism + exclusion of ghost interiors and keep-clear boxes + region membership
        rain.ts              rainPoints(tickXs): the two seeded rain columns (§4) — reuses scatter's point type and fragment
        rain.test.ts         per-column lit cap, taper, glyph set, determinism
        route-geometry.ts    Point, Polyline, length(points), pointAt(points, distance), offsetPath(points) → the CSS path() string — pure
        route-geometry.test.ts
        timeline.ts          the shared 9 s vocabulary: PERIOD, LOOP (the infinite WAAPI options), CUES (per seat: at · settle · jolt · gain), frame(t, style) → a keyframe at t, signed(offset) — data and two pure helpers
        pose.ts              poseAt({ cue, t, box, seen, glitchMs }) → Pose (gaze · lift · gain · jolt): a seat's reaction to the packet at time t — pure
        pose.test.ts
        response.ts          responses(stage): the keyframes the diagram answers the packet with — the card's active row and the implementer/reviewer tick, label and seat flashes
        packet.ts            mountPackets(stage, ghosts, card): the two packets and their wakes on offset-path over the exact route polylines, the clock, pose(name) for the ghosts, start/stop
        ticker.ts            createTicker(target, rate, onTick): fixed-tick rAF loop with IntersectionObserver + visibilitychange pause — shared by ghost.ts (cells) and mount.ts (rain); both consumers are this feature, so it stays here rather than in lib/
        find.ts              find(root, selector): querySelector-or-throw, shared by mount, packet and response
        mount.ts             mountDiagram(root): wires seats → canvases, scatter, rain drift, packets; the only DOM entry for the feature
      fragments/
        pool.ts              the §7.5 string pool — data only
        mount.ts             mountFragments(layer, exclusions): placeFragments(viewport, exclusions) with the travel-band test (seeded via lib/noise, 2000 candidates per string, origins up to 120 px below the fold), the hover animation, re-placement on resize
        mount.test.ts        28 placed clear of every exclusion band and of each other; same seed + same viewport → identical placements
  tests/
    e2e/
      page.e2e.ts            one h1 · lang · title/description · every canvas labelled · every a[href] · five tbody rows · document.fonts.check for the three families · zero console errors · scrollWidth === clientWidth at 390 and 360 · --ink-3 vs #101216 ≥ 4.5 (computed from the live tokens) · dist JS bytes < 20 KB
      motion.e2e.ts          `test.describe` with `test.use({ reducedMotion: 'reduce' })`: two diagram captures 4 s apart are pixel-identical; default: they differ; CSS layer seeked via the Web Animations API — `page.evaluate(t => document.getAnimations().forEach(a => { a.pause(); a.currentTime = t; }), 2600)` — then the .packet--impl box intersects route B's box; ghost loops advanced with page.clock; no fragment box intersects the h1/lede/CTA boxes when sampled at 0, 10, 20, 30 s of animation time
      shots.e2e.ts           writes SHOT_DIR/<SHOT_TAG>-1440.png (full page), -fold.png (1440×900), -390.png (full page, 390×844); SHOT_TIME_MS seeks every CSS animation via getAnimations() and advances page.clock for the ghosts before capture (default 4000)
  tools/
    render-static.ts         prints frame-0 character art per seat (imports the pure diagram modules); run once via `npm run render-static`, output pasted into the three <pre class="ghost-fallback">
```

Rules: kebab-case; basename = primary export and never repeats a path segment (the folder carries the feature name — `diagram/mount.ts`, never `diagram/diagram.ts`); a unit earns a folder at 3+ files, otherwise flat siblings; no `utils`/`helpers`/`common`; no `index.ts` barrels; tests colocated; ≤ 200 lines per file (split per responsibility as above, never by line count alone; `index.html` is exempt for the 65 generated lines of `<pre class="ghost-fallback">` art only — its markup stays under the cap); features never import each other (`copy-button`, `diagram`, `fragments` import only from `lib/` and their own folder; `main.ts` composes); stylesheets live in the shared `src/styles/` tier, one per section. `dist/` and `node_modules/` are gitignored by the repo root already (`dist/`, `node_modules/` patterns are unanchored).

## 14. Verification protocol (every phase)

1. `cd website && SHOT_DIR=<run_dir>/shots SHOT_TAG=p<N> npm run shots` → three PNGs (Playwright builds + previews first; `SHOT_TIME_MS` seeks CSS animations through `getAnimations()` and the ghost loops through `page.clock`).
2. Open each PNG and `reference.png` side by side. Write the defect list **before** touching code: geometry drift (positions vs §4 table), type scale, ink levels, alignment, anything accidental. Name the three worst things first.
3. Fix, re-shoot, re-critique. A phase is done at zero open items on its own surface — not "renders".
4. Gates: `npm run typecheck && npm run lint && npm test && npm run e2e` in `website/` — all green, outputs pasted verbatim.
5. Hand back with: the screenshot paths, the final critique, `craft pass: …` line, and the tell-walk (nuke-design §Verification) result with a 1–10 score anchored to the nuke-design sentences.
