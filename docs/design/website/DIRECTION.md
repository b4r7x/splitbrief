# SPLITBRIEF Website — Design Direction

Decided 2026-07-30 with the maintainer after a five-report research pass (reference-site teardown, content map, stack SOTA, two creative-direction waves) and a three-critic adversarial verification (technical / completeness / design — all findings folded in). This file is the design contract for the implementer. `PLAN.md` holds architecture and tasks; `CONTENT.md` holds copy and IA; `KICKOFF.md` is the implementer's entry point.

## Positioning — the thesis every page answers to

SPLITBRIEF pairs a **supported planner runner with a supported implementer runner**. Five runner kinds are available on either side; built-in tool IDs cover named CLIs and providers, while custom runners use explicit `shell`, `agent`, or `agent-sdk` contracts. The **Task Brief is the contract** between the configured roles. The orchestrator owns validation, retries, escalation, approval gates, drift detection, and resume.

**Cost is a whisper, never a pitch.** Decided explicitly with the maintainer:

- No savings percentages anywhere. No price-first headlines. The words "cheap"/"cheaply" are banned in site copy; say "supported implementers include local models".
- On the landing, cost appears exactly once: the single quiet sentence "You pay for the thinking once." The chosen real TUI frame is grayscale and shows no cost line; keep the site's role colors outside the artifact and do not composite a cost line into it (see CONTENT.md §4).
- The docs may discuss cost properly (there is a Cost management guide) — the landing does not argue price. Content-faithful imports retain their voice while accepting narrow, verified factual corrections (see CONTENT.md import policy).

## The brief

- **Audience:** developers already using AI coding agents; terminal-native, cost-conscious but allergic to hype; they will check whether every artifact on the page is real.
- **Feel:** composable · precise · engineer-credible.
- **Reference point:** the EMS Synthi/VCS3 pin-matrix patchboard (London, 1969) — instrument-panel graphic language: engraved silkscreen legends, jack fields, one brass pin at a crossing.
- **Constraints:** the site must agree with the product's design language — near-black stepped grounds, the planner/implementer two-color duality (the TUI's `terminalTheme` uses named ANSI magenta/cyan; the site's tokens are its own fixed rendering of that duality), figlet wordmark, and the phase rail. The rail's source of truth: stage tokens `RAIL_STAGES = ['spec','plan','briefs','build','verify']` (`src/features/workflow/layout/chrome-rows.ts:29`), title-cased by `formatStageLabel` (`src/core/phase-display.ts`), joined by the real connector glyphs `›` (same role) and `→` (role handoff) from `src/lib/glyphs.ts` — rendered: **`Spec › Plan › Briefs → Build → Verify`**. Never abbreviate, re-order, or substitute separators (`·` exists nowhere in the product). Honest CTA (from source; npm pending). WCAG AA. Static output only.

## The direction: THE PIN MATRIX

**Thesis:** SPLITBRIEF is a patch field — supported planner jacks on one axis, supported implementer jacks on the other. Every displayed intersection expands to a complete, schema-valid config. The matrix is the demo, the diagram, and the value proposition in one object.

### Tokens — dark theme (default; the landing ships ONLY this theme)

| Role | Value | Notes |
|---|---|---|
| Panel Black (ground) | `#0B0B0D`, surfaces step `#141416` / `#1E1E21` | mirrors the TUI |
| Silkscreen (fg) | `#E8E6E1` | engraved-legend off-white |
| Dim silkscreen | `#A8A6A1` | secondary text and code comments; 6.84:1 on `#1E1E21` |
| Planner Magenta | `#E0409A` | **non-text only** (rules, jack bullets — 4.25:1 on `#1E1E21` clears the 3:1 non-text minimum but fails text AA) |
| Planner Magenta (text) | `#E85FA8` | any magenta at text size (5.2:1 on `#1E1E21`, 6.2:1 on `#0B0B0D`) |
| Implementer Cyan | `#3FD2E0` | safe for text on all three dark surfaces (9.1–10.8:1) |
| Matrix Grid (decorative) | `#2A2A2E` | background hairline texture ONLY — deliberately sub-3:1, exempt from the AA rule because no meaning rides on it |
| Matrix Grid (functional) | `#6E6E76` (3.29:1 on `#1E1E21`) | cell boundaries, jack outlines, anything a user must perceive to operate the matrix |
| Pin Brass | `#C9A26B` | the seated pin ONLY; nothing else is brass |
| Focus ring | `2px solid #E8E6E1`, 2px offset | via `:focus-visible`; the seated cell keeps the same ring — focus and selection never share a channel |
| Crosshair wash | accent at 8% alpha | the SOLE permitted wash; paint it inset inside cells/labels so functional grid pixels remain on the base surface |

**AA rule:** every accent must pass its WCAG threshold against the **lightest surface it appears on** (`#1E1E21`), not just Panel Black. Record final values as tokens in P2 with measured ratios.

**Light theme ("silkscreen-on-aluminum") exists ONLY under `/docs/*`** and is **re-toned, never inverted** (inverting kills both accents — cyan lands at ~1.4:1 on light ground). Final P2 values: ground `#E8E6E1`, surfaces step darker `#DDDBD6` / `#D2D0CB`, ink `#1A1A1C`, dim ink `#55554F`, functional grid `#6E6E68` (3.33:1 worst case; its `#8A8A84` predecessor measured 2.25–2.78:1), non-text planner `#B01D72`, **`--planner-text: #A01A67`** on every light surface, Implementer Cyan → teal `#0B5E66` (4.85:1 worst case), Pin Brass → `#7A5F33`, focus ring `2px solid #1A1A1C`. Exact measurements for every semantic token on every surface are recorded in `AA-TABLE.md`. **Worst-case rule per theme:** dark theme measures against the LIGHTEST surface a color appears on; light theme against the DARKEST step — the AA rule always binds at the theme's worst case, not its ground.

Accent discipline: magenta and cyan each stay under ~5% page coverage — labels, jack bullets, rules — never washes (single sanctioned exception: the crosshair wash token), **zero gradients anywhere**. Syntax highlighting draws ONLY from the token palette — stock shiki/highlight themes are banned (see PLAN.md: two custom token-derived shiki themes).

### Type

| Role | Face | Notes |
|---|---|---|
| Display | **Archivo** (Expanded widths) | ALL-CAPS panel legends, faceplate headers; used with restraint |
| Body | **Instrument Sans** | all running text |
| Mono | **Fragment Mono** | YAML, brief excerpts, TUI frames, install block |

Starting type scale (P2/P3 tune it; the critic judges the result, not these numbers): display headline `clamp(32px, 5vw, 72px)` Archivo Expanded caps; panel-strip legends 13px Archivo Expanded caps, 0.14em tracking; body 16px/1.6 Instrument Sans, ~68ch measure; mono (YAML, briefs, install) 14px/1.5 Fragment Mono; small labels 12px.

All three are Google Fonts (OFL) — self-host woff2, `font-display: swap`, **preload the display + mono woff2 in `<head>`**. Archivo's Expanded width requires the variable font retaining the `wdth` axis (or explicit Expanded named instances) — static default downloads silently drop it and gut the faceplate look; exact instances and the specimen gate are pinned in PLAN.md P0. Ship exactly what the CSS names, nothing more (the reference site's mistake: named a body font it never shipped, and FOUTed its identity font by not preloading).

### Layout stance

The hero **is an instrument face**, full-bleed — no centered headline over cards, no three-up feature grid anywhere on the site. Below the hero, sections are horizontal **panel strips** ruled like module faceplates: an engraved ALL-CAPS legend (Archivo) on the strip's top rule, content inside. The page reads as one rack, not a stack of marketing sections.

### Signature element — the live pin matrix

Planner jacks labeled down the left edge; implementer jacks across the top; the matrix between. Exact jack lists and the YAML each crossing emits are specified in `CONTENT.md` (every fragment must be valid against `docs/CONFIGURATION.md` — the real keys are `tool:` for cli and `provider`/`apiBase` for api, never `baseUrl`).

Behavior:

- **Hover and focus crosshair, one mechanic:** pointer hover and keyboard focus produce the same row/column emphasis. The active row rule-lines and rowheader label shift to full magenta; the column's rules and columnheader shift to full cyan; the active cell gets a 1px two-tone outline plus the separate focus ring when keyboard-focused. Crosshair washes are inset inside cells and labels; they never cover or reduce the contrast of the functional grid.
- **Click**: a brass pin seats in the cell and the real YAML for that pairing renders beneath the matrix in a bordered frame with a copy button. One pin is pre-seated on load (claude-code × Ollama) — rendered already-seated, **no entrance animation**.
- **Targets:** every interactive cell and jack has a preferred hit area of at least 44×44 CSS px and never falls below the WCAG 2.2 minimum of 24×24 CSS px. The visible pin may be smaller; its target may not.
- **Desktop (`min-width: 700px`):** render one `<table role="grid" aria-label="Planner × implementer pairings">`. The header row exposes implementer jacks as `columnheader`; each data row begins with a planner `rowheader`; focusable `gridcell`s use one roving `tabindex="0"` (all others `-1`). Arrows move one cell, Home/End move to row bounds, and Enter/Space seats the pin. Exactly one cell has `aria-selected="true"`.
- **Mobile (`max-width: 699px`):** render two stacked single-select groups, `role="radiogroup"` with labels "Planner" and "Implementer"; each jack is a radio with roving tabindex and exactly one `aria-checked="true"` per group. Selecting one side preserves the other. The current jack uses the brass pin dot. Do not leave the desktop grid mounted, focusable, or exposed to accessibility APIs.
- **Announcement contract:** both layouts feed one shared, visually hidden `role="status"` that announces only the selected pair (for example, "Config updated: claude-code × ollama"). The YAML output is a plain labeled region and is **never `aria-live`**. Default selection is claude-code × Ollama.

### Motion — one concept: "the patch takes"

On a **user-initiated pin drop only**, a single pulse travels row → pin → column (sequenced opacity, ~400ms, one shared easing), then the YAML swaps. It is click-driven — no IntersectionObserver, no scroll triggers. **Nothing else on the site animates** — no scroll reveals, no parallax, no typewriter loops. `prefers-reduced-motion`: pin and YAML change instantly; the crosshair highlight remains because it is state, not animation.

### Hero contents & viewport priority

Elements: figlet "Splitbrief" wordmark small as an engraved panel legend (reuse `src/features/home/logo.ts`, **compact tier**; rendered `role="img" aria-label="splitbrief"`, rows `aria-hidden` — the page's `<h1>` is the headline, not the wordmark); one global header `<nav aria-label="Primary">` containing the bracket links `[ docs ] [ github ]` (footer links are contextual, not a second global nav); the matrix with the pre-seated pin; the emitted YAML; the frozen headline **"Patch your planner into your implementer."**; quiet sub-line "The Task Brief is the signal between them."; and a source-only `InstallBlock` labeled "from source — not yet on npm". Do not ship a dormant mode switch or hidden npm variant.

**Priority order (binding — the critic must not fail the hero for honoring it):** must be visible on load at every width = headline + wordmark legend + the matrix (or mobile picker) with its seated pin. The YAML sits beside the matrix at ≥1024px, directly below it otherwise. The install block MAY fall below the fold on viewports shorter than ~800px and always does at 390px.

### Docs inheritance

Docs carry the vocabulary, not the artifact — the matrix itself never appears in docs:

- Sidebar items get **jack bullets** with redundant shape treatment: planner-side pages use a filled magenta jack; implementer-side pages use a cyan ring/hollow jack; neutral items use neither role treatment. Color is never the only distinction.
- Page titles in Archivo caps at faceplate scale; body Instrument Sans at a readable measure (~68ch max); dark theme default with the re-toned light theme behind a toggle (docs only — the landing has no toggle).
- Code blocks reuse the bordered-frame treatment from the matrix output; anchor links on h2/h3; copy button on every bordered code frame.
- Callouts are panel-strip slips, not colored blobs; the phase rail `Spec › Plan › Briefs → Build → Verify` (real connectors) may appear as a wayfinding strip on workflow-related pages.
- **Docs mobile (< 700px), designed not shrunk:** the sidebar collapses into a top panel-strip disclosure (engraved legend "INDEX", jack bullets preserved) above the content; the TOC collapses into a "ON THIS PAGE" disclosure between title and body. Docs pages must be fully usable at 390px (P4 gate + e2e).

## Owner amendments (2026-07-31)

Ruled by the maintainer after the landing was rebuilt around the matrix. These override the clauses they name; everything else in this file stands.

- **The hero is the CLI entrance, recreated in HTML and labeled as one.** `src/features/landing/terminal/` renders the real `splitbrief` home screen — faceplate (`~ % splitbrief` / `html recreation`), figlet wordmark, pairing status line, Recent sessions, the verbatim hint row, and a composer whose input is real (Enter jumps to the patch field). This is a **sanctioned exception to gate row 5**: it is not a real capture, so it carries its own provenance label on the faceplate and never claims to be a screenshot. Its blinking block cursor and the pairing cycler are the entrance's only motion.
- **Headline: "Patch any planner into any implementer."** — `any planner` in `--planner-text`, `any implementer` in `--implementer`. The OG surface carries the same line.
- **The atmospheric floor is hero-only.** One blurred radial wash plus grain, behind the entrance, nowhere else on the site.
- **The pairing cycler is the hero's motion moment.** Six real crossings from `pairings.ts`, one every 4s, paused when `document.hidden`, held on the pre-seated pairing under `prefers-reduced-motion`. "The patch takes" pulse remains the matrix's own concept.
- **Consequence — viewport priority changes.** The matrix moves out of the hero into its own `PATCH FIELD` panel strip directly below it. What must be visible on load is now the headline plus the entrance (which contains the wordmark and a live pairing); the matrix sits one section down. The landing order is Hero → Patch field → Breath → Signal → Runner kinds → Console → Interlock → Modes → Install → Footer.
- **Consequence — wordmark cell.** The lock still holds (hard px cell, `pre`, resize by `transform: scale()` only), but the measured row step is **1.47em**, not a terminal's 1.2em: Fragment Mono's stems and underscores carry more ink than a terminal cell's and collide into an unreadable mass at the tighter step.

## Anti-default gate — every row must pass before ship

1. **Type:** no Inter/Roboto/Open Sans/system-ui as a chosen face (system stack only as fallback chain).
2. **Palette:** no navy `#0B1120` lane, no blue/purple gradient, no glassmorphism, no cream+terracotta, no acid-green broadsheet. Accents ≤ 2 (magenta + cyan; brass is the pin only). Stock syntax-highlight themes count as a palette violation.
3. **Layout:** no centered-hero-plus-three-cards anywhere; the instrument face and panel strips are the system.
4. **Signature** is nameable in a sentence: "the live pin matrix that emits real config."
5. **Cliché scan:** no emoji feature icons, no icon-in-tinted-circle grids, no logo cloud, no "Ready to get started?" footer, no fake-typing terminal chrome. Terminals appear only as **real, load-bearing artifacts** (real tui-shots frames, real YAML, real brief text).
6. **Motion:** exactly one concept (the patch pulse), reduced-motion respected.
7. **Copy bans (site copy — landing, titles/descriptions, rewrite/new pages):** "supercharge", "10x", "AI-powered", "seamless", "blazingly fast", "unleash", "effortless", savings percentages, "cheap". Content-faithful imports keep their voice but still receive the verified factual corrections named in `CONTENT.md`.

## The floor — creativity never trades these

- WCAG AA everywhere, measured per the AA rule above (lightest surface each color appears on, both themes where both exist).
- Visible keyboard focus (the focus-ring token) on every interactive element; matrix focus mirrors its hover crosshair exactly, and both matrix layouts follow the breakpoint semantics above.
- Body-copy links are underlined in every state across the landing and docs; color may reinforce but never replace the underline.
- Real responsive behavior: mobile is a designed layout (matrix picker; docs disclosures), not a shrink.
- Semantic HTML under the styling; landmarks; one `<h1>` per page.
- `prefers-reduced-motion` honored as a designed end state.
- Performance sanity: hero assets are SVG/woff2, no multi-MB payloads; Lighthouse budgets in `PLAN.md` are binding.

## Critique loop — before the word "done"

1. Render and screenshot at desktop (1440) and mobile (390) widths.
2. A **fresh critic** (agent that did not author the code) receives: this file, the screenshots, and the gate + floor above — not the author's reasoning. Verdict per feel word (`composable/precise/engineer-credible`: earned|missed) and per gate row (pass|fail), each with a concrete fix ("the matrix legends are timid — Archivo Expanded caps at ≥13px with 0.14em tracking"), never "polish it".
3. Fix and re-critique; cap 3 cycles; a failed gate row is a redesign, not a caveat.

Scope: the full loop runs at P3 (landing). The docs shell gets **one** critique cycle at P4. All verdicts are recorded in `docs/design/website/CRITIQUE.md`.

## Fallback — trigger, owner, and dissent note

The kill test: **does clicking a crossing feel like completing a circuit, and is the emitted YAML copy-paste-runnable?** The objective half (YAML validity) is a P3 gate test. The subjective half is evaluated **only by the P3 fresh critic** — never by the implementer's own judgment. If after the 3-cycle cap the critic still fails the matrix on gate row 4 or the feel words, the implementer **STOPS and escalates to the maintainer**: the fallback (EXPOSED PIPELINE — white-room brutalism, visible grid, box-drawing state machine with swappable end-sockets, hazard-yellow accent) requires a fresh DIRECTION pass and is never an implementer-side decision. Dissent recorded: The Split (page bisected by a seam the brief crosses, magenta/cyan worlds) scored closest to the thesis but carries the highest craft risk (pixel-exact clip-path split-rendering); a dedicated craft budget would revive it.

## Real-artifact rules (binding)

- `InstallBlock` is source-only and contains the README's actual commands, complete: `git clone https://github.com/b4r7x/splitbrief.git` → `cd splitbrief` → `npm install` → `npm run build` → `npm link` (the `cd` is part of the artifact — dropping it breaks the paste). No dormant npm mode ships.
- All 36 hero YAML documents are complete root configs and pass `ConfigSchema.safeParse` (`kind:` discriminant; `tool:` for cli; `provider`/`apiBase`/explicit `model` for api — never `baseUrl`; `version: 3`; required `validation` and `workflow` blocks). Model provenance and dated verification follow `CONTENT.md`.
- Brief artifacts have exactly **three** truthful forms — use only these, and name which one you're showing: (a) the **nine semantic section names** from `docs/TASK-CONTRACT.md` (Identity, Intent, Scope, Code Context, Implementation Plan, Validation, Constraints, Escalation, Evidence) as a legend/list; (b) the **`tasks.md` transport block** — the on-disk artifact the user reviews at the approval gate: YAML frontmatter (`id`/`title`/`action`/`file`/`depends_on`) + `### …` headings, per `docs/TASK-CONTRACT.md` ("Example task entry") and `src/engine/spec/prompts/task-format-example.ts`; (c) the **rendered implementer prompt** exactly as `src/engine/spec/prompt-formatter.ts` emits it — `## Task: <title>` / `### Action:` / `### File:` then `### Description`, `### Scope`… (no frontmatter in THIS form). Never mix the forms in one excerpt and never invent section names.
- Phase-rail rendering matches the product: `formatStageLabel` title-casing over `RAIL_STAGES` with the `›`/`→` connector glyphs — `Spec › Plan › Briefs → Build → Verify`. The P3 gate check: every rail label on the site appears verbatim in `src/features/workflow/layout/chrome-rows.ts`'s stage list (title-cased), and separators are the product's connector glyphs, not `·` or `/`.
- Every TUI frame is a real capture from the regenerated gallery (`npm run tui-shots`) — existing frames carry a retired brand and must not ship. Prefer the SVG output. Fixture credibility is handled in P0 (see PLAN.md).
- Numbers shown are whatever real artifacts show — never composited.
