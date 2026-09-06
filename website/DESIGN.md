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
| **brief card** (`figure`, 84×104) | centre (39%, 46%) → spans x 33.5–44.5%, y 40–52% | `tasks.md` — §5 |
| **route A: planner → card** | horizontal from the planner's right rim (27.8%, 46%) to the card's left edge (33.5%, 46%) | `--ink-3`, `1px dashed` (4px on / 4px off) |
| **route B: card → implementer** | horizontal from the card's right edge (44.5%, 46%) to the implementer's left rim (55%, 46%) — it enters the ghost's lower third | same stroke, straight |
| **route C: card → reviewer** | from the card's bottom centre (39%, 52%) down to (39%, 60%), right to (49%, 60%), down to (49%, 72%), right to the reviewer's left rim (58%, 72%) | same stroke; corners are hard 90°; no curves anywhere |
| **tick + label: planner** | tick 1px × 28px `--ink-3`, top-anchored at (14%, 18%) (ends 21.3%, the crown starts at 24%); label right of the tick, `--text-label` `--ink`: `CLAUDE` / `+ FABLE` | |
| **tick + label: implementer** | tick top-anchored at (67%, 18%); label `OPENCODE` / `+ DEEPSEEK` | |
| **tick + label: reviewer** | tick top-anchored at (76%, 55%) (below the implementer's bottom at 53%, above-right of the reviewer's crown); label `CODEX` / `+ GPT-5.6°` | the `°` marks the seat that signs off |
| **seat label: planner** | top-left at (6%, 60%) — below-left of the ghost (bottom 56%) | `PLAN` (`--ink`) then `ANALYZE` / `DECOMPOSE` / `ROUTE` (`--ink-3`), `--text-micro`; a 1px×12px tick above it; closed by `.dash` |
| **seat label: implementer** | top-left at (84%, 36%) — right of the ghost (right rim 79%) | `IMPLEMENT` / `GENERATE` / `ITERATE` / `TEST` |
| **seat label: reviewer** | top-left at (82%, 76%) — right of the ghost (right rim 78%) | `REVIEW` / `READ` / `EVALUATE` / `CONFIRM` |
| **`+` crosshair** | centre (26%, 63%) | `--ink-3`, 14px — drafting mark |
| **rain** | one dotted column per ghost, exactly at the tick's x (planner 14%, implementer 67%), from y 6% down to y 17.5% — it ends 0.5% above the tick top, so the tick reads as the funnel that carries the rain into the crown | 1px cells `·` every 10px, `--ink-4` → part of the motion concept (§7); the column never touches the tick or its label |
| **scatter** | ~60 `.`/`:`/`·` glyphs in a loose diagonal band from (0%, 6%) to (24%, 26%) plus a sparse halo (≤ 40 glyphs) within 30px of each ghost's rim | `--ink-4`, generated by `features/diagram/scatter.ts` with a fixed seed so renders are deterministic; anything outside the stage is clipped by the box |

The ghosts are the top-3 elements by rendered size on the page after the headline (nuke-design rule 2); nothing in the diagram may be brighter than a ghost's spark cells except the route packet while it travels.

## 5. The brief card (`figure.brief`)

84 × 104px, 1px `--hair-strong`, inset top highlight, background `--bg` (it must occlude the route line behind it). Content, `--text-micro`, `--font-mono`:

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
- eyes: two ellipses centred `(0.34, 0.40)` and `(0.66, 0.40)`, radii `(0.11, 0.13)` → **void** (density 0). A single pupil cell `@` at the eye centre offset **toward the brief card** by one cell (planner: +1 col; implementer: −1 col; reviewer: −1 col and −1 row).

**Density** `d(c, r, t) ∈ [0,1]` for cells inside:
- base `d0 = 0.55 + 0.45 * (1 − dist²)` with `dist = clamp(hypot((u − 0.5) / 0.5, (v − 0.5) / 0.5), 0, 1)` (bright core, sparse rim)
- row texture: even rows `× 1.0`, odd rows `× 0.72` (the reference's `o0o0 / :.:.` banding)
- edge falloff: cells whose 8-neighbourhood is not fully inside `× 0.45`
- breath: `× (0.82 + 0.18 * sin(2π t / P + phase))`, `P` per seat: planner 6.5s, implementer 2.8s, reviewer 9s; `phase`: planner 0, implementer 2.1, reviewer 4.2
- noise: `+ 0.18 * n(c, r, ⌊t*F⌋)` with `n` a seeded value-noise (deterministic per seat; **no `Math.random` at render time**), `F` = planner 6 Hz, implementer 12 Hz, reviewer 4 Hz
- halo: cells **outside** within 2 cells of the rim get `d = 0.08 + 0.1 * n` (the scattered `.` around the reference ghosts)
- reviewer global `× 0.85` (it is the quiet seat — its palette is already all-dim; at `× 0.7` the field never rose above `=` and read as dirt on the canvas, so the gain was raised on 2026-09-07 during Batch 3.B)

**Glyph ramp** (density → char): `' ', '.', ':', '-', '=', 'o', '0', 'O', '@'` — index `⌊d * 8⌋` clamped. **Colour ramp:** `d < .3` → `*-dim` at alpha `.55`; `.3–.7` → accent at alpha `.6 + d*.4`; `> .7` → accent at alpha 1; every cell whose seeded hash `< 0.12` draws in `--white-spark` instead (the sparkle). Reviewer: hash chooses blue-dim / green-dim / spark at 55/35/10.

**Glitch:** every 3–7s (seeded schedule), one random body row shifts by +1 col for 90ms (implementer) or 160ms (planner); the reviewer never glitches.

**Rendering:** one **glyph atlas** per ghost — an offscreen canvas holding each `(glyph, colour)` pair pre-rendered once; the frame loop is `clearRect` + `drawImage` per non-empty cell. Frame loop via `requestAnimationFrame`, but cells update on a fixed tick (planner/implementer 12 fps, reviewer 8 fps); the rAF only redraws when the tick changed. The loop **pauses** when `document.hidden`, when the canvas leaves the viewport (`IntersectionObserver`), and never starts when `matchMedia('(prefers-reduced-motion: reduce)')` matches — then it draws frame `t = 0` once. `ghost.ts` exports `createGhost({ canvas, seat })` → `{ renderFrame(t), start(), stop() }` (grid, seed, and timing come from the `Seat` record in `seats.ts`); `silhouette.ts`, `density.ts`, and `atlas.ts` hold the pure functions and are unit-tested.

**Accessibility:** each canvas carries `role="img"` and `aria-label` — `"Planner daemon: Claude Code with Fable"`, `"Implementer daemon: OpenCode with DeepSeek"`, `"Reviewer daemon: Codex with GPT-5.6"`.

## 7. Motion — one concept: *the system is alive and routing*

Everything that moves belongs to this one idea; nothing else animates.

1. **Breath** — the ghosts' density field (§6). Calm planner, quick implementer, slow reviewer.
2. **Rain** — the dotted column above each of planner and implementer drifts downward at 14px/s (CSS `background-position` animation on a repeating 1px-dot gradient), feeding the crowns.
3. **Packet** — two `--white-spark` `■` elements (7×7px), `.packet--impl` and `.packet--rev`, on one shared 9s timeline: t 0–1.2s `.packet--impl` travels route A (planner rim → card) · 1.2–1.8s it dwells on the card while the card's `T2 … ▸` row brightens to `--ink` · 1.8–3.4s it travels route B (card → implementer), then fades out in 120ms while the implementer's tick label brightens for 0.4s · at 3.4s `.packet--rev` appears at the card's bottom centre and travels route C (4.0s, to 7.4s — route C is 316 stage px, so all three legs move at 36–80px/s and read as one unhurried object), then fades out while the reviewer's tick label brightens for 0.4s · 7.4–9s rest (both hidden). Implemented in `features/diagram/packet.ts` as `offset-path: path(...)` with `offset-distance` keyframes (each path is the exact polyline of its route in stage px at 760×860), so both stay glued to the lines under `transform: scale()`.
4. **Entrance** — on load only: nav, steps, headline lines, lede, CTA fade from `opacity 0; translateY(8px)` to rest, stagger 60ms, duration 480ms, `ease-out`. The diagram fades in as one unit after 240ms. No scroll-triggered animation anywhere; the routes/manifesto sections are static.
5. **Background fragments** — `features/fragments/mount.ts` places 28 mono strings from the pool below across the whole page (`position: fixed` layer behind content, `z-index: -1`, `--ink-4`, 11px, opacity `.18–.35`), each hovering: it drifts upward 120px over 14–28s, fades out over the last 2s, and restarts at its origin (no wrapping, no infinite scroll). Pool: `brief -> implementer`, `typecheck · lint · test`, `retry(3) -> escalate`, `const brief = compile(spec)`, `while (red) retry()`, `promote(diff)`, `evidence.jsonl`, `real software`, `lower spend`, `fewer blind spots`, `one file per brief`, `0x2f 0x62 0x72`, `[ 3 / 7 ]`, `∴`, `//`, `→`, `T1 ✓`, `T2 ▸`, `hash ok`, `worktree`. Origins, drift durations, and opacities are drawn from `lib/noise` `valueNoise` with a fixed seed (no `Math.random` anywhere in `src/`), so the layout is identical on every render and the screenshots are reproducible. Fragments never overlap the headline, the lede, or the CTA: the placer rejects any origin whose box **plus its full 120px travel band** intersects one of those bounding boxes (measured once after fonts load, re-measured on `resize`), so the exclusion holds for every frame; opacity never exceeds `.35`.

`prefers-reduced-motion: reduce` → 1 renders frame 0 only, 2/3/5 are off (`animation: none`, both packets hidden, fragments static at their origins), 4 is replaced by instant visibility. `@media (prefers-reduced-motion)` lives in `src/styles/motion.css` alongside the keyframes; `lib/reduced-motion.ts` owns the single `matchMedia` and its `change` subscription.

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
    main.ts                  boot: mountCopyButton · mountDiagram · mountFragments (the no-js → js swap is the inline head script, §2)
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
      noise.ts               hash(seed, x, y, z) and valueNoise(seed, x, y, z) — pure; consumers: diagram/density.ts, diagram/scatter.ts, fragments/mount.ts (placement seed)
      noise.test.ts
      reduced-motion.ts      prefersReducedMotion(): boolean + onReducedMotionChange(cb) over one matchMedia; consumers: diagram/ghost.ts, fragments/mount.ts, main.ts
    features/
      copy-button.ts         mountCopyButton(button, clipboard): clipboard write, 1.6 s "copied to clipboard" swap, border flash (the hero CTA; two files, so flat)
      copy-button.test.ts    the label/timer logic with vi.useFakeTimers() and a fake clipboard
      diagram/
        seats.ts             the per-seat config table (grid, period, frequency, phase, glitch, palette) — data only
        silhouette.ts        inside(u, v), eye(u, v), pupilCell(seat) — pure
        silhouette.test.ts
        density.ts           density(seat, c, r, t) with breath, banding, edge falloff, noise, halo — pure
        density.test.ts
        atlas.ts             GLYPHS ramp, glyphFor(d), colourFor(seat, d, hash), buildAtlas(seat, dpr) → offscreen canvas it creates itself
        atlas.test.ts        ramp bounds + colour bands (pure parts)
        ghost.ts             createGhost({ canvas, seat }) → { renderFrame(t), start(), stop() }: fixed-tick rAF, IntersectionObserver + visibilitychange pause, reduced-motion frame 0
        scatter.ts           seeded band + halo glyph placement → DocumentFragment
        scatter.test.ts      determinism + exclusion of ghost interiors
        packet.ts            mountPackets(stage): the two offset-path packets on the 9 s timeline and the label/card brightening hooks
        mount.ts             mountDiagram(root): wires seats → canvases, scatter, packets; the only DOM entry for the feature
      fragments/
        pool.ts              the §7.5 string pool — data only
        mount.ts             mountFragments(layer, exclusions): placement with the travel-band test (seeded via lib/noise), hover animation
        mount.test.ts        placement rejects any origin whose box + 120px band intersects an exclusion rect; same seed + same viewport → identical placements
  tests/
    e2e/
      page.e2e.ts            one h1 · lang · title/description · every canvas labelled · every a[href] · five tbody rows · document.fonts.check for the three families · zero console errors · scrollWidth === clientWidth at 390 and 360 · --ink-3 vs #101216 ≥ 4.5 (computed from the live tokens) · dist JS bytes < 20 KB
      motion.e2e.ts          `test.describe` with `test.use({ reducedMotion: 'reduce' })`: two diagram captures 4 s apart are pixel-identical; default: they differ; CSS layer seeked via the Web Animations API — `page.evaluate(t => document.getAnimations().forEach(a => { a.pause(); a.currentTime = t; }), 2600)` — then the .packet--impl box intersects route B's box; ghost loops advanced with page.clock; no fragment box intersects the h1/lede/CTA boxes when sampled at 0, 10, 20, 30 s of animation time
      shots.e2e.ts           writes SHOT_DIR/<SHOT_TAG>-1440.png (full page), -fold.png (1440×900), -390.png (full page, 390×844); SHOT_TIME_MS seeks every CSS animation via getAnimations() and advances page.clock for the ghosts before capture (default 4000)
  tools/
    render-static.ts         prints frame-0 character art per seat (imports the pure diagram modules); run once via `npm run render-static`, output pasted into the three <pre class="ghost-fallback">
```

Rules: kebab-case; basename = primary export and never repeats a path segment (the folder carries the feature name — `diagram/mount.ts`, never `diagram/diagram.ts`); a unit earns a folder at 3+ files, otherwise flat siblings; no `utils`/`helpers`/`common`; no `index.ts` barrels; tests colocated; ≤ 200 lines per file (split per responsibility as above, never by line count alone); features never import each other (`copy-button`, `diagram`, `fragments` import only from `lib/` and their own folder; `main.ts` composes); stylesheets live in the shared `src/styles/` tier, one per section. `dist/` and `node_modules/` are gitignored by the repo root already (`dist/`, `node_modules/` patterns are unanchored).

## 14. Verification protocol (every phase)

1. `cd website && SHOT_DIR=<run_dir>/shots SHOT_TAG=p<N> npm run shots` → three PNGs (Playwright builds + previews first; `SHOT_TIME_MS` seeks CSS animations through `getAnimations()` and the ghost loops through `page.clock`).
2. Open each PNG and `reference.png` side by side. Write the defect list **before** touching code: geometry drift (positions vs §4 table), type scale, ink levels, alignment, anything accidental. Name the three worst things first.
3. Fix, re-shoot, re-critique. A phase is done at zero open items on its own surface — not "renders".
4. Gates: `npm run typecheck && npm run lint && npm test && npm run e2e` in `website/` — all green, outputs pasted verbatim.
5. Hand back with: the screenshot paths, the final critique, `craft pass: …` line, and the tell-walk (nuke-design §Verification) result with a 1–10 score anchored to the nuke-design sentences.
